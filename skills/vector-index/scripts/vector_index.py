#!/usr/bin/env python3
"""
vector_index — a global, local, in-process semantic RAG store, partitioned by
PROJECT.

This is the corpus-agnostic RAG engine that originally lived inside the
`semantic-html` skill (which hard-coded the MDN content repo), generalized twice:
first to arbitrary named indexes, and now to a *global context keyed by project*.

The mental model:

    $VINDEX_HOME   ── the one global RAG database (a directory)
      ├── scene/        ── one project  (its own zvec collection + config)
      ├── portfolio/    ── another project
      └── rustbook/     ── …

Every project is an isolated collection, but they live under one roof and can be
searched together. There are two ways to ask a question:

    project search  — within a single project (auto-resolved from your cwd)
    global search   — fan out across *all* projects, merge + cross-encoder
                      rerank, and tag each hit with the project it came from.

"Auto-resolved from your cwd" is the ergonomic core: when an agent (or you) is
working inside ~/Documents/Projects/scene, the tools resolve the `scene`
project without being told — the same way a project-scoped code-intel server
knows which repo you're in. Resolution order:

    1. $VINDEX_PROJECT                         (explicit pin wins)
    2. the project whose `root` is the nearest ancestor of cwd
    3. a `.vindex` marker / `.git` root walking up from cwd (name = dir basename)
    4. $VINDEX_DEFAULT  (default "default")

Pipeline (all local, no API keys, no network at query time):

    files -> chunk -> embed (sentence-transformers) -> zvec collection
    query -> embed -> vector top-k -> cross-encoder rerank -> results

Design notes carried over from the original engine (hard-won):
  * zvec has no commit(); persist with flush() then optimize().
  * collection.stats is a property, not a method.
  * Chunk text is STORED in the index (output field "text"), so search never
    has to reconstruct from disk — fixes the legacy "stores_text: false" indexes.

The public library surface is the `Project` class plus the module helpers
`resolve_project_name`, `global_search`, `project_records`, and `list_projects`.
`Index` remains the lower-level store primitive that `Project` wraps; older code
importing `Index` keeps working.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import asdict, dataclass, field
from fnmatch import fnmatch
from pathlib import Path

import numpy as np

import zvec
from sentence_transformers import CrossEncoder, SentenceTransformer

# ---------------------------------------------------------------------------
# Locations & defaults (all overridable via env)
# ---------------------------------------------------------------------------
HOME = Path(
    os.environ.get(
        "VINDEX_HOME",
        os.path.join(
            os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
            "vector-index",
        ),
    )
)
DEFAULT_EMBED_MODEL = os.environ.get("VINDEX_EMBED_MODEL", "all-MiniLM-L6-v2")
DEFAULT_RERANK_MODEL = os.environ.get(
    "VINDEX_RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L6-v2"
)
# The project used when nothing else resolves. Kept as VINDEX_DEFAULT for
# backwards-compat; VINDEX_PROJECT is the explicit per-process pin.
DEFAULT_PROJECT = os.environ.get("VINDEX_DEFAULT", "default")
DEFAULT_INDEX = DEFAULT_PROJECT  # legacy alias

# Files/dirs that mark a project root when walking up from a cwd.
_ROOT_MARKERS = (".vindex", ".git")

# How a file extension maps to a chunking strategy.
_MARKDOWN_EXT = {".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"}
_CODE_EXT = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".lua",
    ".sh", ".css", ".scss", ".sql", ".html", ".vue", ".svelte",
}

_EMBEDDERS: dict[str, SentenceTransformer] = {}
_RERANKERS: dict[str, CrossEncoder] = {}
_dim_cache: dict[str, int] = {}


# ---------------------------------------------------------------------------
# Models (cached singletons keyed by model name)
# ---------------------------------------------------------------------------
def get_embedder(model: str = DEFAULT_EMBED_MODEL) -> SentenceTransformer:
    if model not in _EMBEDDERS:
        _EMBEDDERS[model] = SentenceTransformer(model)
    return _EMBEDDERS[model]


def get_reranker(model: str = DEFAULT_RERANK_MODEL) -> CrossEncoder:
    if model not in _RERANKERS:
        _RERANKERS[model] = CrossEncoder(model)
    return _RERANKERS[model]


def embed_dim_for(model: str = DEFAULT_EMBED_MODEL) -> int:
    if model not in _dim_cache:
        _dim_cache[model] = int(get_embedder(model).get_sentence_embedding_dimension())
    return _dim_cache[model]


# ---------------------------------------------------------------------------
# Chunking — universal, strategy chosen per file (or forced via config)
# ---------------------------------------------------------------------------
def _strip_frontmatter(text: str) -> str:
    return re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.DOTALL)


def chunk_markdown(text: str, min_chars: int, max_chars: int) -> list[str]:
    """Split at heading boundaries, then cap oversize sections by paragraph."""
    text = _strip_frontmatter(text)
    if len(text.strip()) < min_chars:
        return [text.strip()] if text.strip() else []
    parts = re.split(r"(?=^#{1,6}\s)", text, flags=re.MULTILINE)
    chunks, buf = [], ""
    for part in parts:
        if not part.strip():
            continue
        if len(buf) + len(part) > max_chars and buf:
            chunks.append(buf.strip())
            buf = part
        else:
            buf += "\n" + part
    if buf.strip():
        chunks.append(buf.strip())

    final: list[str] = []
    for c in chunks:
        if len(c) <= max_chars:
            final.append(c.strip())
            continue
        buf = ""
        for p in c.split("\n\n"):
            if len(buf) + len(p) > max_chars and buf:
                final.append(buf.strip())
                buf = p
            else:
                buf += "\n\n" + p
        if buf.strip():
            final.append(buf.strip())
    return [c for c in final if len(c) >= min_chars or len(final) == 1]


def chunk_sliding(text: str, max_chars: int, overlap: int, by_line: bool) -> list[str]:
    """Fixed-size window with overlap. Splits on line boundaries for code."""
    text = text.rstrip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    out: list[str] = []
    if by_line:
        lines = text.splitlines(keepends=True)
        buf = ""
        for ln in lines:
            if len(buf) + len(ln) > max_chars and buf:
                out.append(buf)
                # carry an overlap tail
                tail = buf[-overlap:] if overlap else ""
                buf = tail + ln
            else:
                buf += ln
        if buf.strip():
            out.append(buf)
    else:
        step = max(1, max_chars - overlap)
        for start in range(0, len(text), step):
            out.append(text[start : start + max_chars])
    return [c.strip() for c in out if c.strip()]


def _title_for(text: str, rel: str) -> str:
    m = re.search(r"^#{1,6}\s+(.+)$", text, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return Path(rel).stem.replace("_", " ").replace("-", " ")


def chunk_file(rel: str, text: str, cfg: "ChunkConfig") -> list[str]:
    strategy = cfg.strategy
    ext = Path(rel).suffix.lower()
    if strategy == "auto":
        if ext in _MARKDOWN_EXT:
            strategy = "markdown"
        elif ext in _CODE_EXT:
            strategy = "code"
        else:
            strategy = "text"
    if strategy == "markdown":
        return chunk_markdown(text, cfg.min_chars, cfg.max_chars)
    if strategy == "code":
        return chunk_sliding(text, cfg.max_chars, cfg.overlap, by_line=True)
    return chunk_sliding(text, cfg.max_chars, cfg.overlap, by_line=False)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class ChunkConfig:
    strategy: str = "auto"  # auto | markdown | code | text
    min_chars: int = 200
    max_chars: int = 1500
    overlap: int = 150


@dataclass
class Source:
    id: str
    type: str = "dir"  # dir | git
    path: str | None = None  # for type=dir (absolute or ~)
    repo: str | None = None  # for type=git
    ref: str = "HEAD"  # git branch/tag
    subdir: str = ""  # ingest only this subdir of the source root
    globs: list[str] = field(default_factory=lambda: ["**/*.md", "**/*.mdx", "**/*.txt"])
    exclude: list[str] = field(default_factory=lambda: ["**/node_modules/**", "**/.git/**"])
    base_url: str | None = None  # e.g. "https://host/docs/{path}"
    strip_ext: bool = True  # drop file extension when building url
    lower_url: bool = False


@dataclass
class IndexConfig:
    name: str                       # the project name
    root: str | None = None         # the project's filesystem root (for cwd resolution)
    embed_model: str = DEFAULT_EMBED_MODEL
    rerank_model: str = DEFAULT_RERANK_MODEL
    embed_dim: int = 0  # filled on create
    chunk: ChunkConfig = field(default_factory=ChunkConfig)
    sources: list[Source] = field(default_factory=list)

    @staticmethod
    def load(name: str) -> "IndexConfig":
        p = config_path(name)
        if not p.exists():
            raise FileNotFoundError(
                f"No project named {name!r} at {index_dir(name)}. Create it first."
            )
        d = json.loads(p.read_text())
        d["chunk"] = ChunkConfig(**d.get("chunk", {}))
        d["sources"] = [Source(**s) for s in d.get("sources", [])]
        d.setdefault("root", None)  # tolerate pre-project configs
        return IndexConfig(**d)

    def save(self) -> None:
        index_dir(self.name).mkdir(parents=True, exist_ok=True)
        config_path(self.name).write_text(json.dumps(asdict(self), indent=2))


def index_dir(name: str) -> Path:
    return HOME / name


def index_path(name: str) -> str:
    return str(index_dir(name) / "index.zvec")


def config_path(name: str) -> Path:
    return index_dir(name) / "config.json"


def list_indexes() -> list[str]:
    if not HOME.exists():
        return []
    return sorted(p.name for p in HOME.iterdir() if (p / "config.json").exists())


# `project` is the user-facing vocabulary; `index` is the storage primitive.
list_projects = list_indexes


# ---------------------------------------------------------------------------
# Project resolution — "which project does this directory belong to?"
# ---------------------------------------------------------------------------
def _project_roots() -> dict[str, str]:
    """Map of project name -> absolute root path, for projects that set one."""
    out: dict[str, str] = {}
    for name in list_indexes():
        try:
            cfg = IndexConfig.load(name)
        except Exception:
            continue
        if cfg.root:
            out[name] = str(Path(os.path.expanduser(cfg.root)).resolve())
    return out


def _walk_up_for_marker(start: Path) -> Path | None:
    """Return the nearest ancestor (inclusive) containing a root marker."""
    cur = start
    for _ in range(64):
        if any((cur / m).exists() for m in _ROOT_MARKERS):
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def resolve_project_name(cwd: str | os.PathLike | None = None) -> str:
    """Figure out the active project for a working directory.

    See the module docstring for the precedence. This never raises and never
    requires the resolved project to exist yet — callers decide whether to
    create it. A `.vindex` file may contain a single line naming the project,
    which overrides the directory basename.
    """
    pin = os.environ.get("VINDEX_PROJECT")
    if pin:
        return pin

    here = Path(os.path.expanduser(str(cwd))) if cwd else Path.cwd()
    try:
        here = here.resolve()
    except Exception:
        pass

    # 2. nearest configured project root that is an ancestor of (or equal to) cwd.
    best: tuple[int, str] | None = None
    for name, root in _project_roots().items():
        rootp = Path(root)
        if here == rootp or rootp in here.parents:
            depth = len(rootp.parts)
            if best is None or depth > best[0]:
                best = (depth, name)
    if best:
        return best[1]

    # 3. walk up for a marker; name from a `.vindex` file, else dir basename.
    marker_dir = _walk_up_for_marker(here)
    if marker_dir is not None:
        vindex_file = marker_dir / ".vindex"
        if vindex_file.is_file():
            named = vindex_file.read_text().strip().splitlines()
            if named and named[0].strip():
                return named[0].strip()
        return marker_dir.name

    # 4. fall back to the configured default.
    return DEFAULT_PROJECT


# ---------------------------------------------------------------------------
# Source resolution (clone git repos, walk dirs, build urls)
# ---------------------------------------------------------------------------
def _source_root(name: str, src: Source) -> Path:
    if src.type == "git":
        dest = index_dir(name) / "sources" / src.id
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            print(f"  cloning {src.repo} -> {dest} (depth=1)", flush=True)
            cmd = ["git", "clone", "--depth", "1"]
            if src.ref and src.ref != "HEAD":
                cmd += ["--branch", src.ref]
            cmd += [src.repo, str(dest)]
            subprocess.run(cmd, check=True, capture_output=True)
        return dest / src.subdir if src.subdir else dest
    root = Path(os.path.expanduser(src.path or "."))
    return root / src.subdir if src.subdir else root


def _matches(rel: str, src: Source) -> bool:
    if not any(fnmatch(rel, g) or fnmatch(rel, g.lstrip("*/")) for g in src.globs):
        # also allow simple suffix globs like **/*.md to match top-level files
        if not any(rel.endswith(g.split("*")[-1]) for g in src.globs if "*" in g):
            return False
    return not any(fnmatch(rel, e) for e in src.exclude)


def iter_files(name: str, src: Source):
    """Yield (abs_path, rel_path) for files in a source matching its globs."""
    root = _source_root(name, src)
    if not root.exists():
        print(f"  !! source {src.id} root missing: {root}", flush=True)
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for fn in filenames:
            full = Path(dirpath) / fn
            rel = str(full.relative_to(root))
            if _matches(rel, src):
                yield full, rel


def url_for(src: Source, rel: str) -> str | None:
    if not src.base_url:
        return None
    p = rel
    if src.strip_ext:
        p = re.sub(r"\.[^./]+$", "", p)
    if src.lower_url:
        p = p.lower()
    return src.base_url.replace("{path}", p)


# ---------------------------------------------------------------------------
# The index (storage primitive)
# ---------------------------------------------------------------------------
_COLL_FIELDS = ["source_id", "source", "title", "chunk", "url", "text"]


class Index:
    def __init__(self, cfg: IndexConfig):
        self.cfg = cfg
        self._coll = None

    # -- lifecycle ----------------------------------------------------------
    @classmethod
    def create(cls, name: str, **kw) -> "Index":
        cfg = IndexConfig(name=name, **kw)
        if cfg.root:
            cfg.root = str(Path(os.path.expanduser(cfg.root)).resolve())
        cfg.embed_dim = embed_dim_for(cfg.embed_model)
        cfg.save()
        return cls(cfg)

    @classmethod
    def load(cls, name: str = DEFAULT_PROJECT) -> "Index":
        return cls(IndexConfig.load(name))

    @classmethod
    def load_or_create(cls, name: str = DEFAULT_PROJECT, **kw) -> "Index":
        return cls.load(name) if config_path(name).exists() else cls.create(name, **kw)

    def _schema(self) -> "zvec.CollectionSchema":
        return zvec.CollectionSchema(
            name=self.cfg.name,
            fields=[
                zvec.FieldSchema("source_id", zvec.DataType.STRING),
                zvec.FieldSchema("source", zvec.DataType.STRING),
                zvec.FieldSchema("title", zvec.DataType.STRING),
                zvec.FieldSchema("chunk", zvec.DataType.INT32),
                zvec.FieldSchema("url", zvec.DataType.STRING),
                zvec.FieldSchema("text", zvec.DataType.STRING),
            ],
            vectors=zvec.VectorSchema(
                "embedding", zvec.DataType.VECTOR_FP32, self.cfg.embed_dim
            ),
        )

    def open(self):
        if self._coll is not None:
            return self._coll
        p = index_path(self.cfg.name)
        if os.path.exists(p):
            self._coll = zvec.open(path=p)
        else:
            self._coll = zvec.create_and_open(path=p, schema=self._schema())
        return self._coll

    def add_source(self, src: Source) -> None:
        self.cfg.sources = [s for s in self.cfg.sources if s.id != src.id] + [src]
        self.cfg.save()

    # -- ingest -------------------------------------------------------------
    def ingest(self, rebuild: bool = False, embed_batch: int = 64, insert_batch: int = 128):
        if rebuild:
            import shutil

            shutil.rmtree(index_path(self.cfg.name), ignore_errors=True)
            self._coll = None
        coll = self.open()
        embedder = get_embedder(self.cfg.embed_model)

        # Phase 1: gather chunks across all sources.
        pending = []  # (text, source_id, rel, title, ci, url)
        n_files = 0
        for src in self.cfg.sources:
            for full, rel in iter_files(self.cfg.name, src):
                try:
                    content = full.read_text(encoding="utf-8")
                except Exception:
                    continue
                n_files += 1
                url = url_for(src, rel)
                for ci, ch in enumerate(chunk_file(rel, content, self.cfg.chunk)):
                    title = _title_for(ch, rel)
                    pending.append((ch, src.id, rel, title, ci, url))
        print(f"  {n_files} files -> {len(pending)} chunks", flush=True)
        if not pending:
            return {"files": 0, "chunks": 0}

        # Phase 2: embed + insert in batches.
        total = 0
        batch: list = []

        def flush():
            nonlocal batch, total
            if batch:
                coll.insert(batch)
                total += len(batch)
                print(f"\r  indexed {total}/{len(pending)}", end="", flush=True)
                batch = []

        for start in range(0, len(pending), embed_batch):
            window = pending[start : start + embed_batch]
            vecs = embedder.encode(
                [w[0] for w in window],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            for (text, sid, rel, title, ci, url), emb in zip(window, vecs):
                doc_id = "v" + hashlib.sha256(f"{sid}\0{rel}\0{ci}".encode()).hexdigest()[:30]
                batch.append(
                    zvec.Doc(
                        id=doc_id,
                        vectors={"embedding": emb.tolist()},
                        fields={
                            "source_id": sid,
                            "source": rel,
                            "title": title,
                            "chunk": ci,
                            "url": url or "",
                            "text": text,
                        },
                    )
                )
                if len(batch) >= insert_batch:
                    flush()
        flush()
        # zvec 0.4+: no commit() — flush() then optimize() to persist + compact.
        if hasattr(coll, "flush"):
            coll.flush()
        if hasattr(coll, "optimize"):
            coll.optimize()
        print(f"\n  done: {total} chunks -> {index_path(self.cfg.name)}", flush=True)
        return {"files": n_files, "chunks": total}

    # -- search -------------------------------------------------------------
    def search(self, query: str, topk: int = 8, rerank: bool = True, fetch_k: int = 0):
        coll = self.open()
        fetch_k = fetch_k or max(topk * 4, 24)
        emb = get_embedder(self.cfg.embed_model).encode(
            query, normalize_embeddings=True
        ).tolist()
        hits = coll.query(
            vectors=zvec.VectorQuery("embedding", vector=emb),
            topk=fetch_k,
            include_vector=True,
            output_fields=_COLL_FIELDS,
        )
        items = []
        for h in hits:
            text = h.field("text") or ""
            items.append(
                {
                    "id": h.id,
                    "source_id": h.field("source_id") or "",
                    "source": h.field("source") or "",
                    "title": h.field("title") or h.field("source") or "",
                    "url": h.field("url") or None,
                    "chunk": h.field("chunk") or 0,
                    "vector_score": float(h.score),
                    "text": text,
                    "snippet": " ".join(text.split())[:240],
                    "_vec": h.vector("embedding"),
                }
            )
        reranked = False
        if rerank and items:
            ce = get_reranker(self.cfg.rerank_model)
            scores = ce.predict([(query, (it["text"] or it["title"])[:2000]) for it in items])
            for it, s in zip(items, scores):
                it["rerank_score"] = round(float(s), 4)
            items.sort(key=lambda r: r["rerank_score"], reverse=True)
            reranked = True
        items = items[:topk]
        return {"query": query, "reranked": reranked, "results": items}

    # -- status -------------------------------------------------------------
    def doc_count(self) -> int:
        try:
            coll = self.open()
            stats = coll.stats  # property, not a method
            for attr in ("doc_count", "num_docs", "count", "size", "n_docs", "num_vectors"):
                if hasattr(stats, attr):
                    return int(getattr(stats, attr))
            if isinstance(stats, dict):
                for k in ("num_docs", "count", "size"):
                    if k in stats:
                        return int(stats[k])
        except Exception:
            pass
        return -1

    def status(self) -> dict:
        p = index_path(self.cfg.name)
        return {
            "project": self.cfg.name,
            "name": self.cfg.name,  # legacy alias
            "root": self.cfg.root,
            "state": "ready" if os.path.exists(p) else "empty",
            "doc_count": self.doc_count() if os.path.exists(p) else 0,
            "index_path": p,
            "embed_model": self.cfg.embed_model,
            "rerank_model": self.cfg.rerank_model,
            "embed_dim": self.cfg.embed_dim,
            "sources": [
                {"id": s.id, "type": s.type, "ref": s.repo or s.path} for s in self.cfg.sources
            ],
        }


# ---------------------------------------------------------------------------
# Project — the project-facing API (a thin, ergonomic layer over Index)
# ---------------------------------------------------------------------------
class Project:
    """One project in the global RAG store.

    A project is an isolated semantic index with a name and (optionally) a
    filesystem root used to auto-resolve it from a working directory.

        Project.create("scene", root="~/Documents/Projects/scene",
                       source="~/Documents/Projects/scene", strategy="code")
        Project.resolve().search("how does the flock loop pick ideas?")
        global_search("welded indexed geometry")   # across every project
    """

    def __init__(self, index: Index):
        self.index = index

    # -- identity -----------------------------------------------------------
    @property
    def name(self) -> str:
        return self.index.cfg.name

    @property
    def root(self) -> str | None:
        return self.index.cfg.root

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"<Project {self.name!r} root={self.root!r}>"

    # -- lifecycle ----------------------------------------------------------
    @classmethod
    def create(cls, name: str, **kw) -> "Project":
        return cls(Index.create(name, **kw))

    @classmethod
    def load(cls, name: str = DEFAULT_PROJECT) -> "Project":
        return cls(Index.load(name))

    @classmethod
    def load_or_create(cls, name: str = DEFAULT_PROJECT, **kw) -> "Project":
        return cls(Index.load_or_create(name, **kw))

    @classmethod
    def resolve(cls, cwd: str | os.PathLike | None = None, create: bool = False) -> "Project":
        """Load the project that owns `cwd` (or the current directory).

        With create=True, an unconfigured resolved project is created on the
        fly (handy for "index the repo I'm standing in").
        """
        name = resolve_project_name(cwd)
        if create:
            return cls.load_or_create(name)
        return cls.load(name)

    @classmethod
    def all(cls) -> list["Project"]:
        out = []
        for n in list_projects():
            try:
                out.append(cls.load(n))
            except Exception:
                continue
        return out

    # -- mutation -----------------------------------------------------------
    def set_root(self, root: str) -> None:
        self.index.cfg.root = str(Path(os.path.expanduser(root)).resolve())
        self.index.cfg.save()

    def add_source(self, src: Source) -> None:
        self.index.add_source(src)

    # -- work ---------------------------------------------------------------
    def ingest(self, **kw) -> dict:
        return self.index.ingest(**kw)

    def search(self, query: str, topk: int = 8, rerank: bool = True, fetch_k: int = 0) -> dict:
        res = self.index.search(query, topk=topk, rerank=rerank, fetch_k=fetch_k)
        res["project"] = self.name
        for r in res["results"]:
            r["project"] = self.name
        return res

    def status(self) -> dict:
        return self.index.status()


# ---------------------------------------------------------------------------
# Global context — search & introspection across every project
# ---------------------------------------------------------------------------
def project_records() -> list[dict]:
    """A compact summary of every project in the global store."""
    out = []
    for name in list_projects():
        try:
            st = Index.load(name).status()
            out.append(
                {
                    "project": name,
                    "root": st.get("root"),
                    "state": st.get("state"),
                    "doc_count": st.get("doc_count"),
                    "sources": len(st.get("sources", [])),
                }
            )
        except Exception as e:  # pragma: no cover - best effort
            out.append({"project": name, "error": str(e)})
    return out


def global_search(
    query: str,
    topk: int = 8,
    rerank: bool = True,
    projects: list[str] | None = None,
    per_project: int = 0,
) -> dict:
    """Search across every project (or a named subset) and merge the results.

    Each candidate is tagged with its `project`. When `rerank` is on, the
    cross-encoder scores all candidates from all projects together, so the
    final ordering is comparable across projects even if they use different
    embedding models. Without rerank we fall back to per-project vector scores,
    which are *not* comparable across differing embed models — so rerank is the
    recommended (and default) mode for global queries.
    """
    names = projects or list_projects()
    per_project = per_project or max(topk * 3, 12)
    pool: list[dict] = []
    searched: list[str] = []
    for name in names:
        try:
            proj = Project.load(name)
        except Exception:
            continue
        if not os.path.exists(index_path(name)):
            continue
        # Pull a generous candidate set per project; defer ranking to the union.
        res = proj.search(query, topk=per_project, rerank=False)
        pool.extend(res["results"])
        searched.append(name)

    if not pool:
        return {"query": query, "scope": "global", "reranked": False,
                "projects": searched, "results": []}

    reranked = False
    if rerank:
        ce = get_reranker(DEFAULT_RERANK_MODEL)
        scores = ce.predict([(query, (it["text"] or it["title"])[:2000]) for it in pool])
        for it, s in zip(pool, scores):
            it["rerank_score"] = round(float(s), 4)
        pool.sort(key=lambda r: r["rerank_score"], reverse=True)
        reranked = True
    else:
        pool.sort(key=lambda r: r.get("vector_score", 0.0), reverse=True)

    results = pool[:topk]
    for r in results:
        r.pop("_vec", None)
    return {
        "query": query,
        "scope": "global",
        "reranked": reranked,
        "projects": searched,
        "results": results,
    }


# ---------------------------------------------------------------------------
# Background auto-populate helper (used by the MCP / viewer servers)
# ---------------------------------------------------------------------------
def ensure_populated_async(name: str = DEFAULT_PROJECT):
    """If the project exists but is empty and has sources, ingest in a thread."""

    def _work():
        try:
            idx = Index.load(name)
            if idx.doc_count() <= 0 and idx.cfg.sources:
                idx.ingest()
        except Exception as e:  # pragma: no cover - best effort
            print(f"[vector_index] auto-populate skipped: {e}", file=sys.stderr)

    t = threading.Thread(target=_work, daemon=True)
    t.start()
    return t
