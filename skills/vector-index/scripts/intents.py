#!/usr/bin/env python3
"""
intents — intent memory & resolution tracking (harness-agnostic core).

The rest of the plugin indexes *files*. This module indexes the *conversation*:
it records what a user asks (the intent), how often a semantically similar thing
has been asked before (frequency), the assistant's response, and whether that
response resolved the intent (outcome). When a new message matches a known
intent, `recall` surfaces the prior resolutions — including failures to avoid —
so a hook can inject them into context before the assistant replies.

Storage is local-first and needs no daemon:

  * SQLite ($VINDEX_HOME/__intents__/intents.db) is the authoritative, mutable
    store — one global DB with a `project` column so recall can prefer the
    current project and fall back to every project (`intent`, `intent_resolution`
    tables). Stdlib `sqlite3`, WAL mode for the hook + async-writer race.
  * A BM25 sidecar + an optional zvec collection give lexical and (when the embed
    model is resident) semantic recall. Both are derived from SQLite and rebuilt
    by the async writer, so losing them never loses data.

Design rules mirrored from the rest of the codebase: model loading is lazy and
optional (the recall fast-path never imports the embed stack), every write
honours VINDEX_READONLY, and nothing reaches the network at query time. Grading
prefers a LOCAL Ollama judge when available and otherwise falls back to a
transcript heuristic, so the no-network guarantee holds even without Ollama.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Only the lexical fast-path deps are imported eagerly (both stdlib-only), so this
# module — and the recall hook — load without the embedding stack. vector_index
# (which pulls in zvec + sentence-transformers) is imported lazily, on the vector
# paths only. The store location is read from $VINDEX_HOME exactly as
# vector_index computes it, so the two always agree.
import hybrid as hybridlib
import assemble

INTENTS_DIR_NAME = "__intents__"
_RESOLUTION_CAP = 12          # keep at most N resolutions per intent (best + recent)
_EXCERPT_CHARS = 600          # store short response excerpts, not whole replies

# Lexical canonicalization: greetings/filler that add no intent signal.
_FILLER = {
    "hi", "hey", "hello", "please", "pls", "thanks", "thank", "you", "could",
    "can", "would", "will", "kindly", "just", "now", "ok", "okay", "so", "well",
    "the", "a", "an", "to", "of", "for", "and", "is", "are", "do", "does", "i",
    "we", "me", "my", "our", "it", "this", "that", "how", "what", "why", "help",
}
_CODE_FENCE = re.compile(r"```.*?```|`[^`]*`", re.DOTALL)
_WORD = re.compile(r"[a-z0-9]+")

_ACCEPT = re.compile(
    r"\b(thanks|thank you|works|worked|perfect|great|awesome|nice|"
    r"that fixed|that did it|solved|resolved|exactly|brilliant)\b", re.I)
_REJECT = re.compile(
    r"\b(no|nope|still|doesn'?t work|does not work|didn'?t work|not working|wrong|"
    r"incorrect|error again|same error|broke|broken|failing|didn'?t help|"
    r"that'?s not|not what)\b", re.I)

_TRUE = {"1", "true", "yes", "on"}


def _env_true(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE


def min_score() -> float:
    try:
        return float(os.environ.get("VINDEX_INTENT_MIN_SCORE", "0.45"))
    except ValueError:
        return 0.45


def max_tokens_default() -> int:
    try:
        return int(os.environ.get("VINDEX_INTENT_MAX_TOKENS", "400"))
    except ValueError:
        return 400


# ---------------------------------------------------------------------------
# Intent canonicalization (pure, model-free — the dedupe & fast-path key)
# ---------------------------------------------------------------------------
def normalize_intent(text: str) -> str:
    """Canonicalize a user message into a stable intent key: drop code fences,
    lowercase, keep word/number tokens, and strip greeting/filler words so
    "Hey, can you reset the dev database please" and "reset dev database" collapse
    to the same intent."""
    text = _CODE_FENCE.sub(" ", text or "").lower()
    toks = [t for t in _WORD.findall(text) if t not in _FILLER and len(t) > 1]
    return " ".join(toks)


def intent_id(normalized: str) -> str:
    return "i" + hashlib.sha256(normalized.encode("utf-8", "replace")).hexdigest()[:30]


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Optional local Ollama judge (mirrors the daemon's client; stdlib urllib only)
# ---------------------------------------------------------------------------
def _ollama_url() -> str:
    return os.environ.get("UKDB_OLLAMA_URL", "http://localhost:11434").rstrip("/")


def _ollama_model() -> str:
    return os.environ.get("UKDB_OLLAMA_MODEL", "llama3.1:8b")


def ollama_judge(intent_text: str, response: str) -> dict | None:
    """Score how well `response` answered `intent_text` using a LOCAL Ollama model.
    Returns {outcome, score} or None if Ollama is unreachable (caller falls back
    to the heuristic). Never raises."""
    prompt = (
        "You are grading whether an assistant's RESPONSE resolved the user's "
        "INTENT. Reply ONLY with JSON "
        '{"outcome":"resolved|partial|unresolved","score":0..1}. '
        f"\n\nINTENT:\n{intent_text[:1500]}\n\nRESPONSE:\n{response[:3000]}"
    )
    body = {"model": _ollama_model(), "prompt": prompt, "stream": False, "format": "json"}
    try:
        req = urllib.request.Request(
            f"{_ollama_url()}/api/generate",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = json.loads(resp.read())["response"]
        data = json.loads(raw)
        outcome = str(data.get("outcome", "")).lower()
        if outcome not in ("resolved", "partial", "unresolved"):
            return None
        score = float(data.get("score", 0.5))
        return {"outcome": outcome, "score": max(0.0, min(1.0, score))}
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        return None


def heuristic_grade(prev_user: str, next_user: str) -> dict:
    """Grade a resolution from the transcript without a model: if the user's NEXT
    message re-asks a semantically similar intent, the answer didn't land; an
    acceptance phrase confirms success, a rejection phrase confirms failure."""
    sim = _jaccard(normalize_intent(prev_user), normalize_intent(next_user))
    accept = bool(_ACCEPT.search(next_user or ""))
    reject = bool(_REJECT.search(next_user or ""))
    if reject or (sim >= 0.6 and not accept):
        return {"outcome": "unresolved", "score": round(max(0.0, 0.3 - sim * 0.3), 3),
                "grader": "heuristic"}
    if sim >= 0.35 and not accept:
        return {"outcome": "partial", "score": 0.5, "grader": "heuristic"}
    return {"outcome": "resolved", "score": 0.9 if accept else 0.7, "grader": "heuristic"}


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------
def _home() -> Path:
    """The global store root — identical to vector_index.HOME, but computed
    without importing the model stack so the recall fast-path stays light."""
    return Path(
        os.environ.get(
            "VINDEX_HOME",
            os.path.join(
                os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
                "vector-index",
            ),
        )
    )


def intents_dir() -> Path:
    return _home() / INTENTS_DIR_NAME


_ROOT_MARKERS = (".vindex", ".git")


def light_project(cwd: str | os.PathLike | None = None) -> str:
    """A stdlib-only project resolver for the latency-sensitive recall hook, so it
    never imports the model stack. Covers the common cases of
    vector_index.resolve_project_name — $VINDEX_PROJECT, a `.vindex`/`.git` marker
    walking up from cwd, then $VINDEX_DEFAULT. It omits the "configured project
    root is an ancestor" case (which needs every project config); recall's global
    fallback absorbs any resulting scope miss, and the authoritative `project`
    is set by the full resolver in the detached writer."""
    pin = os.environ.get("VINDEX_PROJECT")
    if pin:
        return pin
    here = Path(os.path.expanduser(str(cwd))) if cwd else Path.cwd()
    try:
        here = here.resolve()
    except Exception:
        pass
    cur = here
    for _ in range(64):
        if any((cur / m).exists() for m in _ROOT_MARKERS):
            vindex_file = cur / ".vindex"
            if vindex_file.is_file():
                named = vindex_file.read_text(errors="replace").strip().splitlines()
                if named and named[0].strip():
                    return named[0].strip()
            return cur.name
        if cur.parent == cur:
            break
        cur = cur.parent
    return os.environ.get("VINDEX_DEFAULT", "default")


def _db_path() -> Path:
    return intents_dir() / "intents.db"


def _bm25_path() -> Path:
    return intents_dir() / "intents-bm25.json.gz"


def _zvec_path() -> str:
    return str(intents_dir() / "intents.zvec")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS intent (
    id            TEXT PRIMARY KEY,
    normalized    TEXT NOT NULL,
    intent_text   TEXT NOT NULL,
    project       TEXT NOT NULL DEFAULT '',
    frequency     INTEGER NOT NULL DEFAULT 0,
    first_seen    TEXT, last_seen TEXT,
    first_session TEXT, last_session TEXT,
    embedded      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS intent_resolution (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id        TEXT NOT NULL REFERENCES intent(id),
    session          TEXT, ts TEXT,
    response_excerpt TEXT,
    outcome          TEXT NOT NULL DEFAULT 'unknown',
    score            REAL NOT NULL DEFAULT 0.0,
    grader           TEXT NOT NULL DEFAULT '',
    graded           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_res_intent  ON intent_resolution(intent_id);
CREATE INDEX IF NOT EXISTS ix_intent_proj ON intent(project);
"""


class IntentStore:
    """The local intent memory over a single global SQLite DB."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    # -- lifecycle ----------------------------------------------------------
    @classmethod
    def open(cls) -> "IntentStore":
        intents_dir().mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_db_path()), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.executescript(_SCHEMA)
        return cls(conn)

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    # -- write --------------------------------------------------------------
    def record(self, intent_text: str, *, project: str = "", session: str = "",
               response: str | None = None, sync_embed: bool = False) -> dict:
        """Upsert the intent (incrementing frequency) and, when `response` is
        given, append a pending resolution. With `sync_embed=True` also (re)build
        the lexical + vector recall sidecars from the current SQLite rows."""
        normalized = normalize_intent(intent_text)
        if not normalized:
            return {"status": "empty"}
        iid = intent_id(normalized)
        now = _now()
        cur = self.conn.execute("SELECT frequency FROM intent WHERE id=?", (iid,))
        row = cur.fetchone()
        if row:
            self.conn.execute(
                "UPDATE intent SET frequency=frequency+1, last_seen=?, last_session=?, "
                "intent_text=? WHERE id=?",
                (now, session, intent_text.strip()[:500], iid),
            )
        else:
            self.conn.execute(
                "INSERT INTO intent (id, normalized, intent_text, project, frequency, "
                "first_seen, last_seen, first_session, last_session) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (iid, normalized, intent_text.strip()[:500], project, 1,
                 now, now, session, session),
            )
        # Always open a pending resolution row for this turn: the recall hook
        # records the intent with no response yet, and the Stop hook later attaches
        # the assistant's reply and grades it. A response given up front fills it
        # immediately (e.g. scripted `vindex intent record --response ...`).
        excerpt = (response or "").strip()[:_EXCERPT_CHARS] if response is not None else None
        self.conn.execute(
            "INSERT INTO intent_resolution (intent_id, session, ts, response_excerpt) "
            "VALUES (?,?,?,?)", (iid, session, now, excerpt),
        )
        self._cap_resolutions(iid)
        self.conn.commit()
        # The BM25 sidecar is stdlib-cheap, so keep it fresh on every write (the
        # model-free recall fast-path reads it). The vector sidecar needs the embed
        # model, so only rebuild it when the caller opts in (the detached writer).
        self._rebuild_bm25()
        if sync_embed:
            self._rebuild_vectors()
        return {"status": "ok", "intent_id": iid, "normalized": normalized}

    def _cap_resolutions(self, iid: str) -> None:
        """Keep the best `_RESOLUTION_CAP` resolutions by score, but never trim the
        newest row — that is the pending turn the Stop hook will fill and grade."""
        ids = [r["id"] for r in self.conn.execute(
            "SELECT id FROM intent_resolution WHERE intent_id=? "
            "ORDER BY score DESC, id DESC", (iid,))]
        if len(ids) <= _RESOLUTION_CAP:
            return
        newest = self.conn.execute(
            "SELECT max(id) AS m FROM intent_resolution WHERE intent_id=?",
            (iid,)).fetchone()["m"]
        keep = set(ids[:_RESOLUTION_CAP]) | {newest}
        for stale in ids:
            if stale not in keep:
                self.conn.execute("DELETE FROM intent_resolution WHERE id=?", (stale,))

    def grade(self, iid: str, *, outcome: str, score: float, grader: str,
              response: str | None = None) -> dict:
        """Finalize the most recent (preferably ungraded) resolution of an intent.
        Attaches `response` if the pending row never captured one."""
        row = self.conn.execute(
            "SELECT id, response_excerpt FROM intent_resolution WHERE intent_id=? "
            "ORDER BY graded ASC, id DESC LIMIT 1", (iid,)).fetchone()
        if not row:
            self.conn.execute(
                "INSERT INTO intent_resolution (intent_id, ts, response_excerpt, "
                "outcome, score, grader, graded) VALUES (?,?,?,?,?,?,1)",
                (iid, _now(), (response or "").strip()[:_EXCERPT_CHARS],
                 outcome, score, grader))
        else:
            excerpt = row["response_excerpt"]
            if response and not excerpt:
                excerpt = (response or "").strip()[:_EXCERPT_CHARS]
            self.conn.execute(
                "UPDATE intent_resolution SET outcome=?, score=?, grader=?, graded=1, "
                "response_excerpt=? WHERE id=?",
                (outcome, score, grader, excerpt, row["id"]))
        self.conn.commit()
        return {"status": "ok", "intent_id": iid, "outcome": outcome}

    # -- read ---------------------------------------------------------------
    def _resolutions(self, iid: str) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            "SELECT response_excerpt, outcome, score, grader FROM intent_resolution "
            "WHERE intent_id=? AND response_excerpt IS NOT NULL AND response_excerpt != '' "
            "ORDER BY score DESC, id DESC", (iid,))]

    def recall(self, intent_text: str, *, project: str = "", topk: int = 3,
               max_tokens: int = 0, allow_embed: bool = False) -> dict:
        """Find prior intents similar to `intent_text`. Fast path is fully
        model-free (exact normalized id + BM25, scored by token overlap), with the
        current project preferred over global matches. When `allow_embed` and the
        embed model is already resident, vector neighbours are blended in."""
        normalized = normalize_intent(intent_text)
        max_tokens = max_tokens or max_tokens_default()
        if not normalized:
            return {"query": intent_text, "matches": [], "injection": ""}

        scores: dict[str, float] = {}
        exact = intent_id(normalized)
        if self.conn.execute("SELECT 1 FROM intent WHERE id=?", (exact,)).fetchone():
            scores[exact] = 1.0

        bm = hybridlib.BM25Index.load(_bm25_path())
        if bm is not None:
            for did, _bm in bm.search(normalized, topk=max(topk * 4, 12)):
                cand = self.conn.execute(
                    "SELECT normalized FROM intent WHERE id=?", (did,)).fetchone()
                if cand:
                    s = _jaccard(normalized, cand["normalized"])
                    scores[did] = max(scores.get(did, 0.0), s)

        if allow_embed:
            for did, s in self._vector_neighbours(normalized, topk * 4):
                scores[did] = max(scores.get(did, 0.0), s)

        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        ranked = [(i, s) for i, s in ranked if s >= min_score()]
        # Prefer the current project, then fall back to any project.
        matches: list[dict] = []
        for scope in (project, None) if project else (None,):
            for iid, s in ranked:
                if any(m["intent_id"] == iid for m in matches):
                    continue
                row = self.conn.execute(
                    "SELECT * FROM intent WHERE id=?", (iid,)).fetchone()
                if not row:
                    continue
                if scope is not None and row["project"] != scope:
                    continue
                matches.append({
                    "intent_id": iid,
                    "intent_text": row["intent_text"],
                    "project": row["project"],
                    "frequency": row["frequency"],
                    "match_score": round(s, 3),
                    "resolutions": self._resolutions(iid),
                })
                if len(matches) >= topk:
                    break
            if len(matches) >= topk:
                break

        injection = render_injection(matches, max_tokens=max_tokens) if matches else ""
        return {"query": intent_text, "normalized": normalized,
                "matches": matches, "injection": injection}

    def _vector_neighbours(self, normalized: str, topk: int) -> list[tuple[str, float]]:
        """Semantic neighbours via the zvec sidecar. Returns [] if zvec/model are
        unavailable — recall degrades to lexical-only, never errors."""
        path = _zvec_path()
        if not os.path.exists(path):
            return []
        try:
            import zvec
            import vector_index as vi
            emb = vi.get_embedder().encode(normalized, normalize_embeddings=True).tolist()
            coll = zvec.open(path=path)
            hits = coll.query(queries=zvec.Query("embedding", vector=emb),
                              topk=topk, output_fields=["intent_id"])
            return [(h.field("intent_id") or h.id, float(h.score)) for h in hits]
        except Exception:
            return []

    def _rebuild_bm25(self) -> None:
        """Rebuild the lexical sidecar from SQLite — stdlib only, no model."""
        rows = self.conn.execute("SELECT id, normalized, intent_text FROM intent")
        items = [(r["id"], r["normalized"], {"intent_text": r["intent_text"]}) for r in rows]
        hybridlib.BM25Index().build(items).save(_bm25_path())

    def _rebuild_vectors(self) -> None:
        """Rebuild the zvec semantic sidecar from SQLite. Needs the embed model;
        a no-op (swallowed) when the model stack is unavailable — vector recall is
        optional and the lexical sidecar already covers the fast path."""
        rows = list(self.conn.execute("SELECT id, normalized FROM intent"))
        try:
            import zvec
            import vector_index as vi
            embedder = vi.get_embedder()
            dim = vi.embed_dim_for()
            schema = zvec.CollectionSchema(
                name="intents",
                fields=[zvec.FieldSchema("intent_id", zvec.DataType.STRING)],
                vectors=zvec.VectorSchema("embedding", zvec.DataType.VECTOR_FP32, dim),
            )
            path = _zvec_path()
            import shutil
            shutil.rmtree(path, ignore_errors=True)
            coll = zvec.create_and_open(path=path, schema=schema)
            todo = [(r["id"], r["normalized"]) for r in rows]
            for start in range(0, len(todo), 64):
                window = todo[start:start + 64]
                vecs = embedder.encode([t for _, t in window],
                                       normalize_embeddings=True, show_progress_bar=False)
                coll.insert([
                    zvec.Doc(id=iid, vectors={"embedding": v.tolist()},
                             fields={"intent_id": iid})
                    for (iid, _t), v in zip(window, vecs)])
            if hasattr(coll, "flush"):
                coll.flush()
            if hasattr(coll, "optimize"):
                coll.optimize()
            self.conn.execute("UPDATE intent SET embedded=1")
            self.conn.commit()
        except Exception:
            pass  # vector recall is optional; lexical sidecar already saved

    # -- grading from a transcript -----------------------------------------
    def grade_pending(self, transcript_path: str, *, project: str = "",
                      session: str = "") -> dict:
        """Grade the just-finished exchange from a transcript. Attaches the latest
        assistant response to its pending resolution and grades it (Ollama judge if
        reachable/forced, else heuristic); also finalizes the *previous* user
        turn's resolution now that its follow-up message is visible."""
        import transcript as tx
        msgs = tx.last_exchanges(transcript_path, n=12)
        users = [t for r, t in msgs if r == "user"]
        last_assistant = next((t for r, t in reversed(msgs) if r == "assistant"), "")
        graded: list[dict] = []

        if users and last_assistant:
            u_last = users[-1]
            iid = intent_id(normalize_intent(u_last))
            judged = None
            if not _env_true("VINDEX_INTENT_NO_JUDGE"):
                judged = ollama_judge(u_last, last_assistant)
            if judged:
                self.grade(iid, outcome=judged["outcome"], score=judged["score"],
                           grader="llm", response=last_assistant)
                graded.append({"intent_id": iid, **judged, "grader": "llm"})
            else:
                # capture the response now; heuristic finalization waits for the
                # next user turn (handled below on the following call).
                self._attach_response(iid, last_assistant)

        if len(users) >= 2:
            u_prev, u_next = users[-2], users[-1]
            iid_prev = intent_id(normalize_intent(u_prev))
            already = self.conn.execute(
                "SELECT graded FROM intent_resolution WHERE intent_id=? "
                "ORDER BY id DESC LIMIT 1", (iid_prev,)).fetchone()
            if already and not already["graded"]:
                g = heuristic_grade(u_prev, u_next)
                self.grade(iid_prev, outcome=g["outcome"], score=g["score"],
                           grader=g["grader"])
                graded.append({"intent_id": iid_prev, **g})

        return {"status": "ok", "graded": graded}

    def _attach_response(self, iid: str, response: str) -> None:
        row = self.conn.execute(
            "SELECT id, response_excerpt FROM intent_resolution WHERE intent_id=? "
            "ORDER BY id DESC LIMIT 1", (iid,)).fetchone()
        excerpt = (response or "").strip()[:_EXCERPT_CHARS]
        if row and not row["response_excerpt"]:
            self.conn.execute(
                "UPDATE intent_resolution SET response_excerpt=? WHERE id=?",
                (excerpt, row["id"]))
            self.conn.commit()

    # -- inspection ---------------------------------------------------------
    def stats(self, project: str = "", limit: int = 25) -> list[dict]:
        q = ("SELECT id, intent_text, project, frequency, last_seen FROM intent "
             "{where} ORDER BY frequency DESC, last_seen DESC LIMIT ?")
        if project:
            rows = self.conn.execute(q.format(where="WHERE project=?"),
                                     (project, limit))
        else:
            rows = self.conn.execute(q.format(where=""), (limit,))
        out = []
        for r in rows:
            res = self._resolutions(r["id"])
            best = res[0] if res else None
            out.append({
                "intent_id": r["id"], "intent_text": r["intent_text"],
                "project": r["project"], "frequency": r["frequency"],
                "last_seen": r["last_seen"],
                "best_outcome": best["outcome"] if best else "unknown",
            })
        return out


# ---------------------------------------------------------------------------
# Context injection rendering
# ---------------------------------------------------------------------------
def render_injection(matches: list[dict], *, max_tokens: int = 400) -> str:
    """Build a compact, token-bounded context block from recalled intents: the
    frequency, the best successful resolution, and one cautionary failure to
    avoid. Lines are assembled within `max_tokens` (header first, so it always
    survives). Returns "" when there is nothing useful to inject."""
    if not matches:
        return ""
    m = matches[0]
    successes = [r for r in m["resolutions"] if r["outcome"] in ("resolved", "partial")]
    failures = [r for r in m["resolutions"] if r["outcome"] == "unresolved"]
    lines = [
        f"[intent-memory] You have handled a similar request {m['frequency']} "
        f"time(s) before"
        + (f" (last known outcome: {m['resolutions'][0]['outcome']})."
           if m["resolutions"] else ".")
    ]
    if successes:
        best = successes[0]
        lines.append("Prior resolution that worked:")
        lines.append(f"  - {_oneline(best['response_excerpt'])} ({best['outcome']}).")
    if failures:
        lines.append("Earlier attempt that did NOT resolve it (avoid):")
        lines.append(f"  - {_oneline(failures[0]['response_excerpt'])} (unresolved).")
    if not successes and not failures:
        lines.append(f"(No graded resolution yet for: {_oneline(m['intent_text'])})")
    # Keep as many lines as fit the budget; the header is first so it always lands.
    kept, _ = assemble.assemble_within_budget(
        [{"text": ln} for ln in lines], max_tokens, key="text")
    return "\n".join(item["text"] for item in kept)


def _oneline(text: str, limit: int = 200) -> str:
    return " ".join((text or "").split())[:limit]
