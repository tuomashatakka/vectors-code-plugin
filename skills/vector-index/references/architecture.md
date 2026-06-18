# vector-index — architecture & internals

Read this when extending the engine: changing the record shape, adding a chunking
strategy, swapping models/stores, tuning project resolution, or understanding how
a corpus becomes searchable per-project and globally.

## Module map

```
scripts/vector_index.py   core library — everything below lives here
scripts/vindex.py         CLI wrapper (argparse over the library)
scripts/mcp_server.py     FastMCP stdio server (project-aware tools)
scripts/viewer_server.py  http.server JSON API + serves assets/viewer.html
assets/viewer.html        three.js synapse navigator
```

The library is the single source of truth; every wrapper imports it.

## Two layers: Index (storage) and Project (the API)

- **`Index`** is the storage primitive: one named zvec collection + its
  `IndexConfig`. It knows how to ingest, search, and report status. Unchanged in
  spirit from the pre-project engine; older code importing `Index` still works.
- **`Project`** is the user-facing API wrapping an `Index`. It adds project
  vocabulary, a filesystem `root`, cwd resolution (`Project.resolve`), and tags
  search results with their project name.

`name` (storage) and `project` (vocabulary) are the same string. `list_projects`
is an alias of `list_indexes`.

## Data layout

```
$VINDEX_HOME/                 the global RAG store
└── <project>/
    ├── config.json           IndexConfig (root, models, dim, chunking, sources)
    ├── index.zvec/           the zvec collection (dense)
    ├── bm25.json.gz          the BM25 lexical sidecar (sparse; built at ingest)
    └── sources/<source_id>/  shallow git clones (for type=git sources)
```

`$VINDEX_HOME` defaults to `~/.local/share/vector-index`.

## Config schema (`config.json`)

```jsonc
{
  "name": "scene",                        // the project name
  "root": "/Users/me/Documents/Projects/scene",  // for cwd auto-resolution (nullable)
  "embed_model": "all-MiniLM-L6-v2",
  "rerank_model": "cross-encoder/ms-marco-MiniLM-L6-v2",
  "embed_dim": 384,                       // detected from the model on create
  "chunk": { "strategy": "auto", "min_chars": 200, "max_chars": 1500, "overlap": 150 },
  "sources": [
    {
      "id": "scene",
      "type": "dir",                      // "dir" | "git"
      "path": "/Users/me/Documents/Projects/scene",
      "repo": null, "ref": "HEAD",
      "subdir": "",
      "globs": ["**/*.ts", "**/*.md"],
      "exclude": ["**/node_modules/**", "**/.git/**"],
      "base_url": null,                   // "https://host/docs/{path}"
      "strip_ext": true, "lower_url": false
    }
  ]
}
```

`root` is new. It is the anchor for cwd → project resolution. `create` defaults
it to the `--source` directory for a local-dir project, so resolution works out
of the box without an explicit `--root`.

## Project resolution (`resolve_project_name`)

Given a working directory, the active project is chosen by:

1. `$VINDEX_PROJECT` if set (explicit pin).
2. Among projects that declare a `root`, the one whose root is the cwd or its
   nearest ancestor (longest matching root wins — handles nested projects).
3. Walking up (max 64 levels) for a `.vindex` or `.git` marker. A `.vindex` file
   may name the project on its first line; otherwise the marker directory's
   basename is used. This returns a name even if no such project exists yet, so
   "index the repo I'm in" can create-on-resolve (`Project.resolve(create=True)`).
4. `$VINDEX_DEFAULT` (default `"default"`).

The function never raises and never requires the project to exist — callers
decide whether to create it.

## zvec record shape

One document per chunk. Schema (see `Index._schema`):

| field        | type        | meaning                                   |
| ------------ | ----------- | ----------------------------------------- |
| `embedding`  | VECTOR_FP32 | normalized chunk embedding (dim from model) |
| `source_id`  | STRING      | which configured source produced it       |
| `source`     | STRING      | path relative to the source root          |
| `title`      | STRING      | first heading, else humanized filename    |
| `chunk`      | INT32       | chunk ordinal within the file             |
| `url`        | STRING      | reconstructed public URL (or "")          |
| `text`       | STRING      | the chunk text itself (stored)            |

The `project` field is **not** stored in the record — a project is the whole
collection, so a hit's project is known from which collection it came from.
`Project.search` and `global_search` attach `project` to each result dict.

Doc id = `"v" + sha256(source_id\0source\0chunk)[:30]` — stable, so re-ingesting
the same file overwrites rather than duplicates.

Persistence: `collection.insert(batch)` repeatedly, then once `collection.flush()`
and `collection.optimize()`. There is **no** `commit()` in zvec ≥0.4.

## Pipeline

**Ingest** (`Index.ingest`): for each source, resolve the root (cloning git repos
on demand), walk it, apply globs/excludes, chunk each file, embed in batches
(`encode(normalize_embeddings=True)`), insert in batches, then flush+optimize.

**Project search** (`Index.search` / `Project.search`): embed the query,
`query(vectors=VectorQuery("embedding", …), topk=fetch_k, include_vector=True,
output_fields=…)`, then rerank the candidate set with the cross-encoder and
return the top `topk`. `fetch_k` defaults to `4×topk`. Because `text` is stored,
results are self-contained.

**Global search** (`global_search`): for each project (or a named subset), run a
vector-only search pulling a generous candidate set (`per_project`, default
`max(3×topk, 12)`), tag each candidate with its project, then run **one**
cross-encoder pass over the union and take the global top `topk`. Reranking the
union is what makes scores comparable across projects with different embedding
models; vector scores across differing embed dims/models are not comparable, so
`rerank=False` global search falls back to per-project vector score and is
best-effort only.

## Hybrid retrieval, grounding & orchestration

These capabilities are generalized from two external RAG designs — see
[`generalized-capabilities.md`](generalized-capabilities.md) — and live in
stdlib-only sidecar modules so the heavy model stack stays isolated:

- **`hybrid.py`** — `BM25Index` (Okapi BM25 + a co-stored render-field map,
  persisted as `bm25.json.gz` at ingest), `rrf_fuse` (Reciprocal Rank Fusion), and
  `context_prefix`. `Index.search(hybrid=True)` retrieves dense (zvec) + sparse
  (BM25) in parallel, fuses the two id-rankings with RRF, then cross-encoder
  reranks the union. Each result gains a `signals` list (`dense`/`lexical`); a hit
  found by both is stronger evidence. Projects indexed before this feature have no
  sidecar and transparently fall back to dense-only.
- **Context-prefix chunking** — ingest embeds and lexically indexes
  `context_prefix(title, path, chunk)` while **storing the raw chunk** for display
  (`ChunkConfig.context_prefix`, default on). Cheap precision win against
  boilerplate-heavy corpora.
- **`orchestration.py`** — Bridge-pattern layering for `global_search(shared=[…])`:
  `classify_query_intent` ("our X" → scoped, "the standard X" → shared) sets
  per-layer weights that feed the cross-project RRF; hits are tagged with `layer`.
  With no `shared` layer it's the original equal-weight Pool.
- **`grounding.py`** — `confidence_tier` (high/medium/low from top score + dense/
  lexical agreement; attached to every result set) and `verify_claim` (lexical
  groundedness check).
- **`references.py`** — `extract_references`, `validate_citations` (check
  references in text against the corpus via an injected `search_fn`, flag misses
  `[UNVERIFIED]`), `resolve_reference` (opt-in network HEAD check). Exposed as MCP
  tools `validate_citations` / `resolve_reference`.

## Chunking strategies (`chunk_file`)

- `markdown` — split at heading boundaries (`^#{1,6}`), then cap oversize sections
  by paragraph. Best for docs/notes/wikis.
- `code` — sliding window over **lines** with an overlap tail. Best for source trees.
- `text` — fixed-size character window with overlap. Best for plain prose.
- `auto` — pick per file extension (markdown-ish → markdown, known code ext → code,
  else text).

**Add a strategy**: extend `chunk_file` with a new branch and the `_MARKDOWN_EXT` /
`_CODE_EXT` sets if it should participate in `auto`.

## Swapping models / stores

- **Different embedding model**: pass `--embed-model` on `create` (dim is detected
  automatically). Existing projects must be reindexed if the dim changes. Note:
  global search mixes projects, so cross-encoder rerank (model-agnostic) is what
  keeps mixed-model results comparable.
- **Different reranker**: `--rerank-model`, or `--no-rerank` to skip it.
- **Different store**: the only zvec touchpoints are `Index._schema`, `open`,
  `ingest` (insert/flush/optimize) and `search` (query). Reimplement those four to
  back it with another vector DB; the rest of the library is store-agnostic.
  [`unified-knowledge-db-spec.md`](unified-knowledge-db-spec.md) is a worked
  design for swapping the store to PostgreSQL + pgvector and unifying it with chat
  memory, external references, and a multi-level memory abstraction (DDL in
  [`unified-knowledge-db.sql`](unified-knowledge-db.sql)).

## The 3D viewer

`viewer_server.py` serves one project. It samples up to N docs by probing the
index with random unit vectors (spreads the sample across the space), PCAs their
real embeddings to 3D, and builds knn "synapse" links from cosine similarity.
`/api/search` projects new hits into the same PCA basis and reports their nearest
sampled neighbours so the viewer can splice them in. It reads the stored
`text`/`title`/`url` fields, so it works for any project with no per-domain code.
