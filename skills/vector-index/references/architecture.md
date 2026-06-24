# vector-index — architecture & internals

Read this when extending the engine: changing the data model, adding a chunking
strategy, swapping models, tuning project resolution, or understanding how a
corpus becomes searchable per-project and globally.

> The engine is **TypeScript run directly on [Bun](https://bun.sh)** (no build
> step), backed by **PostgreSQL + pgvector**. Embeddings and reranking are pure
> JS/WASM via `@xenova/transformers` (ONNX) — **no Python, no Docker**. The
> repo-root [`spec.md`](../../../spec.md) is the exhaustive source of truth; this
> doc is the orientation map.

## Module map (`src/`)

```
cli/        command registry + dispatch (index.ts), arg/print kit (kit.ts),
            interactive TUI (tui.ts, opentui), commands/*.ts (one per group)
db/         pool.ts (pg pool, q/q1/tx/toVector), schema.ts (DDL + migrations +
            ensureSpace), projects.ts (registry + cwd resolution),
            ingest.ts (diff-by-hash ingest + AST chunks + import edges), types.ts
chunk/      chunker.ts (markdown/code/text/auto windows), ast.ts (tree-sitter
            WASM per-symbol chunks + import graph), units.ts (unit_type classifier)
embed/      embedder.ts (feature-extraction, mean-pool + L2-norm),
            rerank.ts (cross-encoder sequence classification)
search/     search.ts (hybrid dense+sparse RRF + rerank + confidence),
            grounding.ts, references.ts, assemble.ts, orchestration.ts
intents/    store.ts (Postgres-backed intent memory: record/recall/resolve/grade)
daemon/     daemon.ts (supervisor) + feeders/{chat,source}.ts + worker.ts
mcp/        server.ts (stdio MCP server, 13 tools)
viewer/     server.ts (live 3D viewer HTTP + JSON API, PCA),
            make_demo.ts (static all-projects export + procedural demo)
config.ts   all env config (VINDEX_* canonical; UKDB_* deprecated aliases)
guards.ts   VINDEX_READONLY / VINDEX_ALLOW_ROOTS capability guards
transcript.ts  tolerant JSONL transcript parsing
prompts.ts  grounding / reasoning prompt scaffolds
```

`hooks/` (repo root) holds the Claude Code `UserPromptSubmit` + `Stop` hooks for
intent memory. `references/unified-knowledge-db.sql` is the full DDL.

## The store: one database, many projects

There is **one** PostgreSQL database (`VINDEX_DSN`). Every **project** is a row in
`project`; its documents, chunks, and vectors are partitioned by `project_id`.
The project config (root, models, chunking, sources) lives in the `project` row —
`project.sources` is a **jsonb** array (there is no per-project `config.json` and
no on-disk index; everything is in Postgres).

```
VINDEX_DSN  (one PostgreSQL + pgvector database)
 ├── scene/       a project — own documents + chunks + vectors + root
 ├── portfolio/
 └── rustbook/
```

Core tables (see [`unified-knowledge-db.sql`](unified-knowledge-db.sql) and
[`unified-knowledge-db-spec.md`](unified-knowledge-db-spec.md) for the full
schema):

- `project` — registry: name, `root_path`, models, `sources` (jsonb).
- `document` / `chunk` — content + chunks; `chunk` carries `ordinal`,
  `content_hash`, `unit_type`, `title`, `url`, the raw `text`, and a nullable
  `(space_id, embedding_id)`.
- `embedding_space` + per-space `emb_<model>_<dim>` tables — dense vectors with an
  HNSW index. A space is created on first use (`ensureSpace` in `db/schema.ts`).
- `reference` / `link` — external references + edges, including the AST **import
  graph** (`reference(kind='file')` + `mentions` links).
- `session` / `message` — chat memory mirrored by the daemon's chat feeder.
- `intent` — intent-memory rows (record/recall/resolve/grade).
- `digest_job` / `daemon_state` — the digest queue and feeder watermarks.

## Project resolution (`db/projects.ts`)

Given a working directory, the active project is chosen by:

1. `$VINDEX_PROJECT` if set (explicit pin).
2. Among projects that declare a `root_path`, the one whose root is the cwd or its
   nearest ancestor (longest matching root wins — handles nested projects).
3. Walking up for a `.vindex` or `.git` marker; the marker **directory's
   basename** is used as the name. (The name is returned even if no such project
   exists yet, so "index the repo I'm in" can create-on-resolve.)
4. `$VINDEX_DEFAULT` (default `"default"`).

Resolution never raises; callers decide whether to create the project.

## Ingest (`db/ingest.ts`)

For each configured source, walk it (applying globs/excludes), chunk each file,
and **diff by whole-file content hash** — unchanged files are skipped. Chunks are
written with `INSERT … ON CONFLICT (document_id, ordinal) DO UPDATE`, so
re-ingesting overwrites rather than duplicates. New/changed chunks enqueue an
`embed` `digest_job` (the daemon worker fills `(space_id, embedding_id)`); a
foreground `vectors index` embeds inline. Code files additionally produce
**AST symbol chunks** and persist **import edges** (see below).

## AST + symbol-graph ingestion (`chunk/ast.ts`) — headline feature

Code files are chunked by **tree-sitter** (WASM, via `web-tree-sitter` +
`tree-sitter-wasms`) into **one chunk per named declaration**:

- functions/methods → `symbol` units,
- classes/interfaces/types/enums/consts → `definition` units,

each titled by its symbol (e.g. `src/geo.ts › seedMesh`). Imports are persisted as
`reference(kind='file')` + `mentions` link edges, giving an **import graph** in
the same store. Languages: ts, tsx, js, py, go, rust, java, c, cpp, ruby, php, c#,
swift, kotlin, scala, lua. Unsupported languages fall back to the line-window
chunker.

## Chunking strategies (`chunk/chunker.ts`)

- `markdown` — split at heading boundaries, then cap oversize sections.
- `code` — sliding window over **lines** with an overlap tail.
- `text` — fixed-size character window with overlap.
- `auto` — pick per file extension (markdown-ish → markdown, code ext → AST/code,
  else text).

Ingest embeds and lexically indexes a **context prefix** (`title`, path, chunk)
while **storing the raw chunk** for display — a cheap precision win against
boilerplate-heavy corpora. `chunk/units.ts` (`classifyUnit`) tags every chunk
`section`/`symbol`/`definition`/`code`/`text` (`unit_type`); search can filter by
type.

## Retrieval (`search/search.ts`)

**Per-project search**: embed the query (`embed/embedder.ts`), then run **dense**
(`ORDER BY embedding <=> $q` on the project's `emb_<space>` joined to `chunk`,
filtered by `project_id`) and **sparse** (Postgres full-text `tsvector`/`ts_rank`)
retrieval, fuse the two rankings with **Reciprocal Rank Fusion (RRF)**, then run
the **cross-encoder reranker** (`embed/rerank.ts`) over the fused union. Each hit
carries `signals` (`dense`/`lexical`) and the result set a **confidence tier**
(`search/grounding.ts`). `--no-rerank` returns the raw fused order.

**Global search**: fans out across projects (or a named subset), merges the
candidates, and applies **one** cross-encoder pass over the union — reranking is
what makes scores comparable across projects with different embedding models.
`orchestration.ts` adds Bridge-pattern layer weights for `shared` vs scoped
layers; `assemble.ts` trims results under a token budget (`--max-tokens`);
`references.ts` powers the `validate_citations` / `resolve_reference` MCP tools.

## Swapping models

- **Embedding model**: set `VINDEX_EMBED_MODEL` (or `create_project`'s
  `embed_model`); the dimension is detected from the model. A new
  `(model, dim)` gets its own `emb_<space>` table; changing dim means reindexing.
- **Reranker**: `VINDEX_RERANK_MODEL`, or `--no-rerank` to skip it. Because global
  search mixes projects, the model-agnostic cross-encoder rerank is what keeps
  mixed-model results comparable.

## The 3D viewer (`viewer/`)

`server.ts` serves `assets/viewer.html` plus a small JSON API over a project's
index: it samples up to N chunks, **PCAs their real embeddings to 3D** (via
`ml-pca`), and builds kNN "synapse" links from cosine similarity; `/api/search`
projects new hits into the same PCA basis. `make_demo.ts` provides two static
exports from the same `assets/viewer.html`:

- `exportStaticViewer()` (`vectors viewer`) bakes **every project's** sampled graph
  into `window.VINDEX_PROJECTS` → a self-contained file with a **project picker**,
  openable from `file://`. Needs a live DB.
- `exportViewer()` (`bun run demo-viewer --demo`) injects `window.VINDEX_DEMO=true`
  for the procedural offline demo — **no DB** — producing `docs/viewer-demo.html`,
  the preview embedded on the GitHub Pages site.

`vectors viewer --serve [project]` runs the live server (default port 7341,
`VINDEX_VIEWER_PORT`).
