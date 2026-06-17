#!/usr/bin/env python3
"""
ukdb_daemon — the background worker for the Unified Knowledge Database.

It keeps the Postgres + pgvector store (see references/unified-knowledge-db.sql
and references/unified-knowledge-db-spec.md) continuously up to date from two
feeders and one job worker, all in a single long-lived process suitable for
launchd (macOS) or systemd --user (Linux):

  1. CHAT FEEDER       — watches chat-transcript files (Claude Code / Desktop
                         JSONL by default) and upserts new `session` / `message`
                         rows. Each insert fires the DB trigger that enqueues an
                         `embed` digest job.
  2. SOURCE FEEDER     — re-reads each project's existing vector-index config
                         ($VINDEX_HOME/<project>/config.json) and upserts changed
                         files into `document` / `chunk` (content-hash diffed).
  3. JOB WORKER        — drains the `digest_job` queue: embeds content with
                         sentence-transformers, and runs the "haiku-level" LLM
                         tasks (summaries, fact/reference extraction) against a
                         LOCAL Ollama. Claims jobs with FOR UPDATE SKIP LOCKED so
                         many workers are safe; wakes on LISTEN/NOTIFY and also
                         polls (NOTIFY is best-effort — the poll is the truth).

Design intent: the searchable path (ingest -> embed -> search) never depends on
Ollama; only the derived/abstraction tasks do. Embeddings stay on
sentence-transformers exactly as the rest of the plugin.

Configuration is entirely via environment (see daemon/ukdb-daemon.env.example):

  UKDB_DSN              libpq DSN, e.g. postgresql:///ukdb            (required)
  UKDB_EMBED_MODEL      sentence-transformers model   (default all-MiniLM-L6-v2)
  UKDB_OLLAMA_URL       Ollama base url               (default http://localhost:11434)
  UKDB_OLLAMA_MODEL     Ollama model for digest tasks (default llama3.1:8b)
  UKDB_CHAT_GLOBS       ';'-separated globs of transcript files
                        (default ~/.claude/projects/**/*.jsonl)
  UKDB_VINDEX_HOME      vector-index store to mirror  (default ~/.local/share/vector-index)
  UKDB_POLL_INTERVAL    job-queue poll seconds        (default 5)
  UKDB_FEEDER_INTERVAL  chat+source scan seconds      (default 900)
  UKDB_BATCH            max jobs drained per wake      (default 32)
  UKDB_DISABLE_FEEDERS  "1" to run worker-only        (default off)

This module is intentionally dependency-light: psycopg (v3) and
sentence-transformers are required; Ollama is reached over stdlib urllib; the
source feeder lazily imports the plugin's `vector_index` for its proven chunking
(only needed when mirroring file sources).
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import select
import signal
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg
except Exception:  # pragma: no cover - import-time guidance
    sys.stderr.write(
        "ukdb_daemon: psycopg (v3) is required. Install with:\n"
        "  pip install 'psycopg[binary]'\n"
    )
    raise

# ---------------------------------------------------------------------------
# Config (all from env; see the module docstring)
# ---------------------------------------------------------------------------
DSN = os.environ.get("UKDB_DSN", "")
EMBED_MODEL = os.environ.get("UKDB_EMBED_MODEL", "all-MiniLM-L6-v2")
OLLAMA_URL = os.environ.get("UKDB_OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("UKDB_OLLAMA_MODEL", "llama3.1:8b")
CHAT_GLOBS = [
    os.path.expanduser(g.strip())
    for g in os.environ.get(
        "UKDB_CHAT_GLOBS", "~/.claude/projects/**/*.jsonl"
    ).split(";")
    if g.strip()
]
VINDEX_HOME = Path(
    os.path.expanduser(
        os.environ.get(
            "UKDB_VINDEX_HOME",
            os.path.join(
                os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
                "vector-index",
            ),
        )
    )
)
POLL_INTERVAL = float(os.environ.get("UKDB_POLL_INTERVAL", "5"))
FEEDER_INTERVAL = float(os.environ.get("UKDB_FEEDER_INTERVAL", "900"))
BATCH = int(os.environ.get("UKDB_BATCH", "32"))
DISABLE_FEEDERS = os.environ.get("UKDB_DISABLE_FEEDERS", "") == "1"

_NS = uuid.UUID("6f1d8a3e-2c5b-4e7a-9b0d-1f2a3b4c5d6e")  # stable namespace for det ids
_URL_RE = re.compile(r"https?://[^\s)<>\]\"']+")
_running = True


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} ukdb {msg}", flush=True)


def det_uuid(*parts: object) -> uuid.UUID:
    return uuid.uuid5(_NS, "\0".join(str(p) for p in parts))


def sha256(text: str) -> bytes:
    return hashlib.sha256(text.encode("utf-8", "replace")).digest()


def approx_tokens(text: str) -> int:
    # cheap, good enough for budgeting: ~0.75 words/token
    return max(1, int(len(text.split()) / 0.75))


_embedder = None


def embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer

        log(f"loading embed model {EMBED_MODEL}")
        _embedder = SentenceTransformer(EMBED_MODEL)
    return _embedder


def embed_dim() -> int:
    e = embedder()
    getter = getattr(e, "get_embedding_dimension", None) or e.get_sentence_embedding_dimension
    return int(getter())


def vec_literal(vec) -> str:
    # pgvector accepts a text literal '[1,2,3]' cast to ::vector — avoids needing
    # the pgvector python adapter as a dependency.
    return "[" + ",".join(f"{x:.7g}" for x in vec) + "]"


def ollama_generate(prompt: str, *, fmt: str | None = None) -> str:
    body = {"model": OLLAMA_MODEL, "prompt": prompt, "stream": False}
    if fmt:
        body["format"] = fmt
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["response"]


# ---------------------------------------------------------------------------
# Embedding-space registry (create the per-(model,dim) table on demand)
# ---------------------------------------------------------------------------
def space_table_name(model: str, dim: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_")
    return f"emb_{slug}_{dim}"


def ensure_space(conn) -> tuple[uuid.UUID, str]:
    """Return (space_id, table_name) for the daemon's embed model, creating the
    registry row and the physical per-space table + HNSW index if missing."""
    dim = embed_dim()
    tbl = space_table_name(EMBED_MODEL, dim)
    if not re.fullmatch(r"emb_[a-z0-9_]+", tbl):  # defence-in-depth for the DDL interpolation
        raise ValueError(f"unsafe space table name {tbl!r}")
    row = conn.execute(
        "SELECT id FROM embedding_space WHERE model=%s AND dim=%s AND metric='cosine'",
        (EMBED_MODEL, dim),
    ).fetchone()
    if row:
        return row[0], tbl
    space_id = conn.execute(
        "INSERT INTO embedding_space (model, dim, metric, table_name) "
        "VALUES (%s,%s,'cosine',%s) RETURNING id",
        (EMBED_MODEL, dim, tbl),
    ).fetchone()[0]
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {tbl} ("
        " embedding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
        " space_id uuid NOT NULL REFERENCES embedding_space(id),"
        " content_hash bytea NOT NULL,"
        " token_count integer,"
        f" embedding vector({dim}) NOT NULL,"
        " created_at timestamptz NOT NULL DEFAULT now(),"
        " UNIQUE (space_id, content_hash))"
    )
    conn.execute(
        f"CREATE INDEX IF NOT EXISTS {tbl}_hnsw ON {tbl} "
        f"USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)"
    )
    log(f"created embedding space {EMBED_MODEL} dim={dim} table={tbl}")
    return space_id, tbl


# ---------------------------------------------------------------------------
# daemon_state watermarks
# ---------------------------------------------------------------------------
def state_get(conn, key: str) -> dict:
    row = conn.execute("SELECT value FROM daemon_state WHERE key=%s", (key,)).fetchone()
    return row[0] if row else {}


def state_set(conn, key: str, value: dict) -> None:
    conn.execute(
        "INSERT INTO daemon_state (key, value, updated_at) VALUES (%s,%s,now()) "
        "ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=now()",
        (key, json.dumps(value)),
    )


def enqueue(conn, task: str, payload: dict, dedupe_key: str, priority: int = 100) -> None:
    conn.execute(
        "INSERT INTO digest_job (task, payload, dedupe_key, priority) "
        "VALUES (%s,%s,%s,%s) ON CONFLICT (dedupe_key) DO NOTHING",
        (task, json.dumps(payload), dedupe_key, priority),
    )


# ===========================================================================
# Feeder 1: chat transcripts -> session / message
# ===========================================================================
def _extract_text(content) -> str:
    """Tolerant: transcript `content` may be a string or a list of typed parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict):
                out.append(part.get("text") or part.get("content") or "")
            else:
                out.append(str(part))
        return "\n".join(t for t in out if t)
    return ""


def _parse_transcript(path: str) -> list[tuple[str, str]]:
    """Return [(role, text)] for message-bearing lines, skipping tool/meta events."""
    msgs: list[tuple[str, str]] = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                m = ev.get("message") if isinstance(ev, dict) else None
                role = (m or {}).get("role") or (ev.get("type") if isinstance(ev, dict) else None)
                if role not in ("user", "assistant", "tool"):
                    continue
                text = _extract_text((m or {}).get("content") if m else ev.get("content"))
                if text.strip():
                    msgs.append((role, text))
    except FileNotFoundError:
        pass
    return msgs


def feed_chats(conn) -> int:
    seen = state_get(conn, "chat_offsets")  # {path: n_messages_ingested}
    files: list[str] = []
    for pattern in CHAT_GLOBS:
        files.extend(glob.glob(pattern, recursive=True))
    new_total = 0
    for path in sorted(set(files)):
        msgs = _parse_transcript(path)
        already = int(seen.get(path, 0))
        if len(msgs) <= already:
            continue
        session_id = det_uuid("session", path)
        conn.execute(
            "INSERT INTO session (id, title) VALUES (%s,%s) "
            "ON CONFLICT (id) DO NOTHING",
            (session_id, Path(path).stem),
        )
        for seq in range(already, len(msgs)):
            role, text = msgs[seq]
            conn.execute(
                "INSERT INTO message (id, session_id, role, seq, text, content_hash, token_count) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id, seq) DO NOTHING",
                (det_uuid("msg", session_id, seq), session_id, role, seq, text,
                 sha256(text), approx_tokens(text)),
            )
            new_total += 1
        seen[path] = len(msgs)
    if new_total:
        state_set(conn, "chat_offsets", seen)
        log(f"chat feeder: +{new_total} messages")
    return new_total


# ===========================================================================
# Feeder 2: vector-index file sources -> document / chunk
# ===========================================================================
def _load_vector_index():
    """Lazy import the plugin's proven chunking. Only needed for file mirroring;
    it pulls in zvec, which the rest of the daemon does not require."""
    scripts = Path(__file__).resolve().parent.parent / "scripts"
    sys.path.insert(0, str(scripts))
    import vector_index as vi  # noqa: E402

    return vi


def feed_sources(conn) -> int:
    if not VINDEX_HOME.exists():
        return 0
    try:
        vi = _load_vector_index()
    except Exception as e:
        log(f"source feeder disabled (cannot import vector_index: {e})")
        return 0

    space_id, _tbl = ensure_space(conn)
    n_chunks = 0
    for proj_dir in sorted(p for p in VINDEX_HOME.iterdir() if (p / "config.json").exists()):
        name = proj_dir.name
        try:
            cfg = vi.IndexConfig.load(name)
        except Exception:
            continue
        project_id = det_uuid("project", name)
        conn.execute(
            "INSERT INTO project (id, name, root_path, embed_model, space_id, chunk_cfg) "
            "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET root_path=excluded.root_path",
            (project_id, name, cfg.root, EMBED_MODEL, space_id,
             json.dumps({"strategy": cfg.chunk.strategy, "min_chars": cfg.chunk.min_chars,
                         "max_chars": cfg.chunk.max_chars, "overlap": cfg.chunk.overlap})),
        )
        for src in cfg.sources:
            for full, rel in vi.iter_files(name, src):
                try:
                    content = Path(full).read_text(encoding="utf-8")
                except Exception:
                    continue
                fhash = sha256(content)
                doc_id = det_uuid("doc", project_id, src.id, rel)
                existing = conn.execute(
                    "SELECT content_hash FROM document WHERE id=%s", (doc_id,)
                ).fetchone()
                if existing and bytes(existing[0]) == fhash:
                    continue  # unchanged file -> skip
                url = vi.url_for(src, rel)
                conn.execute(
                    "INSERT INTO document (id, project_id, source_id, rel_path, title, url, "
                    "content, content_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (id) DO UPDATE SET content=excluded.content, "
                    "content_hash=excluded.content_hash, url=excluded.url",
                    (doc_id, project_id, src.id, rel, vi._title_for(content, rel), url,
                     content, fhash),
                )
                for ci, ch in enumerate(vi.chunk_file(rel, content, cfg.chunk)):
                    conn.execute(
                        "INSERT INTO chunk (id, document_id, project_id, ordinal, title, text, "
                        "url, content_hash, token_count, space_id) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT (document_id, ordinal) DO UPDATE SET text=excluded.text, "
                        "content_hash=excluded.content_hash",
                        (det_uuid("chunk", doc_id, ci), doc_id, project_id, ci,
                         vi._title_for(ch, rel), ch, url, sha256(ch), approx_tokens(ch), space_id),
                    )
                    n_chunks += 1
    if n_chunks:
        log(f"source feeder: +{n_chunks} chunks")
    return n_chunks


# ===========================================================================
# Job worker
# ===========================================================================
def _owner_text(conn, kind: str, oid) -> tuple[str, uuid.UUID | None]:
    """Return (text, project_id) for a chunk/message/reference id."""
    if kind == "chunk":
        r = conn.execute("SELECT text, project_id FROM chunk WHERE id=%s", (oid,)).fetchone()
    elif kind == "message":
        r = conn.execute("SELECT text, project_id FROM message WHERE id=%s", (oid,)).fetchone()
    elif kind == "reference":
        r = conn.execute(
            "SELECT coalesce(title,'') || ' ' || coalesce(snippet,''), NULL FROM reference WHERE id=%s",
            (oid,),
        ).fetchone()
    else:
        return "", None
    return (r[0] or "", r[1]) if r else ("", None)


def handle_embed(conn, payload: dict) -> dict:
    kind, oid = payload["node_kind"], payload["id"]
    text, project_id = _owner_text(conn, kind, oid)
    if not text.strip():
        return {"status": "empty"}
    space_id, tbl = ensure_space(conn)
    chash = sha256(text)
    vec = embedder().encode(text, normalize_embeddings=True).tolist()
    emb_id = conn.execute(
        f"INSERT INTO {tbl} (space_id, content_hash, token_count, embedding) "
        f"VALUES (%s,%s,%s,%s::vector) ON CONFLICT (space_id, content_hash) "
        f"DO UPDATE SET token_count=excluded.token_count RETURNING embedding_id",
        (space_id, chash, approx_tokens(text), vec_literal(vec)),
    ).fetchone()[0]
    if kind in ("chunk", "message"):
        conn.execute(
            f"UPDATE {kind} SET space_id=%s, embedding_id=%s WHERE id=%s",
            (space_id, emb_id, oid),
        )
        # L0 memory node anchored to the exact content
        conn.execute(
            "INSERT INTO memory_node (id, project_id, level, anchor_kind, anchor_id, "
            "content_hash, token_count, space_id, embedding_id) "
            "VALUES (%s,%s,'L0',%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET "
            "content_hash=excluded.content_hash, embedding_id=excluded.embedding_id",
            (det_uuid("l0", kind, oid), project_id, kind, oid, chash,
             approx_tokens(text), space_id, emb_id),
        )
        # cascade the cheap, useful extractors
        enqueue(conn, "extract_references", {"node_kind": kind, "id": str(oid)},
                f"extref:{kind}:{oid}")
        if kind == "message":
            enqueue(conn, "extract_facts", {"node_kind": kind, "id": str(oid)},
                    f"extfact:{kind}:{oid}")
    else:  # reference
        conn.execute(
            "UPDATE reference SET space_id=%s, embedding_id=%s WHERE id=%s",
            (space_id, emb_id, oid),
        )
    return {"status": "ok", "embedding_id": str(emb_id)}


def handle_extract_references(conn, payload: dict) -> dict:
    kind, oid = payload["node_kind"], payload["id"]
    text, project_id = _owner_text(conn, kind, oid)
    urls = list(dict.fromkeys(_URL_RE.findall(text)))[:50]
    n = 0
    for u in urls:
        ref_id = conn.execute(
            "INSERT INTO reference (kind, uri) VALUES ('url', %s) "
            "ON CONFLICT (kind, uri) DO UPDATE SET last_seen=now() RETURNING id",
            (u,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO link (src_kind, src_id, dst_kind, dst_id, relation, project_id) "
            "VALUES (%s,%s,'reference',%s,'mentions',%s) "
            "ON CONFLICT (src_kind, src_id, dst_kind, dst_id, relation) DO NOTHING",
            (kind, oid, ref_id, project_id),
        )
        n += 1
    return {"status": "ok", "references": n}


def handle_extract_facts(conn, payload: dict) -> dict:
    kind, oid = payload["node_kind"], payload["id"]
    text, project_id = _owner_text(conn, kind, oid)
    if len(text) < 40:
        return {"status": "too_short"}
    prompt = (
        "Extract durable, reusable facts from the text below: user preferences, "
        "decisions, and stable entities worth remembering for future conversations. "
        "Ignore ephemeral chit-chat. Respond ONLY with a JSON array of objects "
        '{"type":"fact|preference|decision|entity","statement":"...","confidence":0..1}. '
        "If nothing is worth keeping, respond with [].\n\nTEXT:\n" + text[:4000]
    )
    try:
        raw = ollama_generate(prompt, fmt="json")
        facts = json.loads(raw)
        if isinstance(facts, dict):  # some models wrap in {"facts":[...]}
            facts = next((v for v in facts.values() if isinstance(v, list)), [])
    except Exception as e:
        return {"status": "llm_error", "error": str(e)[:200]}
    n = 0
    for f in facts if isinstance(facts, list) else []:
        if not isinstance(f, dict):
            continue
        stmt = (f.get("statement") or "").strip()
        if not stmt:
            continue
        conn.execute(
            "INSERT INTO fact (project_id, fact_type, statement, content_hash, confidence) "
            "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (project_id, content_hash) DO NOTHING",
            (project_id, (f.get("type") or "fact"), stmt, sha256(stmt),
             float(f.get("confidence", 0.5))),
        )
        n += 1
    return {"status": "ok", "facts": n}


def handle_summarize(conn, payload: dict) -> dict:
    """Summarize a set of lower memory_node children into a derived L1/L2 node.
    payload: {level, child_ids[], label?}. Children are memory_node ids."""
    level = payload.get("level", "L1")
    child_ids = payload.get("child_ids", [])
    texts = []
    for cid in child_ids:
        r = conn.execute(
            "SELECT coalesce(mn.summary, c.text, m.text) FROM memory_node mn "
            "LEFT JOIN chunk c ON mn.anchor_kind='chunk' AND mn.anchor_id=c.id "
            "LEFT JOIN message m ON mn.anchor_kind='message' AND mn.anchor_id=m.id "
            "WHERE mn.id=%s",
            (cid,),
        ).fetchone()
        if r and r[0]:
            texts.append(r[0])
    if not texts:
        return {"status": "no_children"}
    joined = "\n---\n".join(t[:1500] for t in texts)[:8000]
    prompt = (
        f"Summarize the following related excerpts into a single concise {level} "
        "summary (3-5 sentences) capturing the shared topic and key points:\n\n" + joined
    )
    try:
        summary = ollama_generate(prompt).strip()
    except Exception as e:
        return {"status": "llm_error", "error": str(e)[:200]}
    space_id, tbl = ensure_space(conn)
    chash = sha256(summary)
    vec = embedder().encode(summary, normalize_embeddings=True).tolist()
    emb_id = conn.execute(
        f"INSERT INTO {tbl} (space_id, content_hash, token_count, embedding) "
        f"VALUES (%s,%s,%s,%s::vector) ON CONFLICT (space_id, content_hash) "
        f"DO UPDATE SET token_count=excluded.token_count RETURNING embedding_id",
        (space_id, chash, approx_tokens(summary), vec_literal(vec)),
    ).fetchone()[0]
    fingerprint = sha256("".join(sorted(str(c) for c in child_ids)))
    node_id = conn.execute(
        "INSERT INTO memory_node (level, summary, label, content_hash, token_count, "
        "space_id, embedding_id, source_fingerprint, generator, generated_at, is_stale) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now(),false) RETURNING id",
        (level, summary, payload.get("label"), chash, approx_tokens(summary),
         space_id, emb_id, fingerprint, f"ollama:{OLLAMA_MODEL}"),
    ).fetchone()[0]
    for cid in child_ids:
        ch = conn.execute("SELECT content_hash FROM memory_node WHERE id=%s", (cid,)).fetchone()
        if ch:
            conn.execute(
                "INSERT INTO derivation (parent_id, child_id, child_hash) VALUES (%s,%s,%s) "
                "ON CONFLICT (parent_id, child_id) DO NOTHING",
                (node_id, cid, ch[0]),
            )
    return {"status": "ok", "node_id": str(node_id)}


# Tasks implemented now; the rest are acknowledged-as-skipped so the queue stays
# clean until a later iteration implements clustering/dedupe/rebuild.
HANDLERS = {
    "embed": handle_embed,
    "extract_references": handle_extract_references,
    "extract_facts": handle_extract_facts,
    "summarize": handle_summarize,
}
SKIP_TASKS = {"cluster_topics", "extract_concepts", "dedupe", "rebuild_abstraction"}


def claim_job(conn):
    return conn.execute(
        "UPDATE digest_job SET state='leased', attempts=attempts+1, "
        "lease_until=now()+interval '5 minutes', updated_at=now() "
        "WHERE id = (SELECT id FROM digest_job WHERE state='queued' "
        "ORDER BY priority, id FOR UPDATE SKIP LOCKED LIMIT 1) "
        "RETURNING id, task, payload, attempts, max_attempts"
    ).fetchone()


def drain_jobs(conn, limit: int) -> int:
    done = 0
    for _ in range(limit):
        job = claim_job(conn)
        if not job:
            break
        jid, task, payload, attempts, max_attempts = job
        try:
            handler = HANDLERS.get(task)
            if handler:
                result = handler(conn, payload)
            elif task in SKIP_TASKS:
                result = {"status": "skipped", "reason": "not yet implemented"}
            else:
                result = {"status": "unknown_task"}
            conn.execute(
                "UPDATE digest_job SET state='done', result=%s, updated_at=now() WHERE id=%s",
                (json.dumps(result), jid),
            )
        except Exception as e:
            err = f"{e}\n{traceback.format_exc()}"[:2000]
            dead = attempts >= max_attempts
            conn.execute(
                "UPDATE digest_job SET state=%s, last_error=%s, updated_at=now() WHERE id=%s",
                ("dead" if dead else "queued", err, jid),
            )
            log(f"job {jid} ({task}) {'DEAD' if dead else 'retry'}: {str(e)[:200]}")
        done += 1
    return done


def reap_leases(conn) -> None:
    conn.execute(
        "UPDATE digest_job SET state='queued', updated_at=now() "
        "WHERE state='leased' AND lease_until < now()"
    )


# ===========================================================================
# Main loop
# ===========================================================================
def _stop(signum, frame):  # noqa: ARG001
    global _running
    _running = False
    log(f"received signal {signum}, shutting down")


def main() -> int:
    if not DSN:
        sys.stderr.write("ukdb_daemon: UKDB_DSN is required (libpq DSN to the unified DB)\n")
        return 2
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(f"starting (ollama={OLLAMA_URL} model={OLLAMA_MODEL}, feeders={'off' if DISABLE_FEEDERS else 'on'})")
    conn = psycopg.connect(DSN, autocommit=True)
    conn.execute("LISTEN digest")
    ensure_space(conn)  # fail fast if the schema/pgvector isn't there

    last_feed = 0.0
    while _running:
        try:
            reap_leases(conn)
            if not DISABLE_FEEDERS and (time.time() - last_feed) >= FEEDER_INTERVAL:
                feed_chats(conn)
                feed_sources(conn)
                last_feed = time.time()
            drained = drain_jobs(conn, BATCH)
            if drained >= BATCH:
                continue  # more work waiting; loop immediately
            # wait for a NOTIFY or until the poll interval elapses
            select.select([conn], [], [], POLL_INTERVAL)
            conn.execute("SELECT 1")  # consume any pending notifications
        except psycopg.OperationalError as e:
            log(f"db connection lost ({e}); reconnecting in 5s")
            time.sleep(5)
            try:
                conn = psycopg.connect(DSN, autocommit=True)
                conn.execute("LISTEN digest")
            except Exception as e2:
                log(f"reconnect failed: {e2}")
        except Exception as e:
            log(f"loop error: {e}\n{traceback.format_exc()}")
            time.sleep(2)

    conn.close()
    log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
