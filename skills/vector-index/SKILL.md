---
name: vector-index
description: >
  A global, local, in-process semantic RAG store partitioned by PROJECT. One
  store on disk; every project is its own embedded + cross-encoder-reranked index,
  and the active project is auto-resolved from the working directory (so an agent
  working inside a repo just gets that repo's retrieval, hsci-style). Supports
  per-project search AND global cross-project search that merges + reranks hits
  from every project. Use this whenever the user wants to "search my docs/notes/
  codebase", build a local RAG / retrieval index, "index this project", give a
  local LLM or agent grounded project-scoped retrieval, set up a vector DB over
  files, ask questions across one repo or across all their projects, or wire
  semantic search into an MCP / Ollama / opencode / Claude setup — even if they
  don't say the word "vector". Trigger on phrases like "semantic search over X",
  "index this repo", "RAG for my projects", "search across all my projects",
  "vector DB keyed by project", "what did we decide in <project>", or "let the
  agent search the current project". Everything runs locally: no API keys, no
  network at query time.
---

# vector-index

A **global RAG store, indexed by project**. One PostgreSQL + pgvector database
holds many projects; each project is its own embedded + cross-encoder-reranked
index, but they share a roof and can be searched together. Point it at a corpus,
get reranked **hybrid** (dense + lexical) semantic search back — per project or
across all of them — plus an MCP server and a 3D embedding viewer.

Implemented in **TypeScript, run directly on [Bun](https://bun.sh)** (no build
step). Embeddings (`all-MiniLM-L6-v2`, 384-d) and the cross-encoder reranker run
on-device as **ONNX via Transformers.js** — **no Python, no PyTorch**. AST
chunking uses `web-tree-sitter` + `tree-sitter-wasms` (pure JS/WASM).

```
VINDEX_DSN              one PostgreSQL + pgvector database
  ├── scene/            a project: own documents + chunks + vectors + root
  ├── portfolio/        another project
  └── rustbook/         …

per-project:  files → chunk → embed → store              (ingest, incremental)
              query → embed → dense+sparse → RRF → rerank (search, fast, offline)
global:       fan out across every project → merge → one rerank → tagged hits
```

## The core idea: project is auto-resolved from the working directory

When you (or an agent) are working inside `~/Documents/Projects/scene`, the tools
resolve the `scene` project for you. Resolution order:

1. `$VINDEX_PROJECT` — an explicit per-process pin (wins over everything).
2. The project whose configured `root_path` is the nearest ancestor of the cwd.
3. Walking up for a `.git` / `.vindex` marker; the name is the marker dir's
   basename.
4. `$VINDEX_DEFAULT` (default `"default"`).

A per-repo MCP server (Claude Code, opencode) "just works" on the right project.
A server with no stable cwd (Claude Desktop) should pin `$VINDEX_PROJECT`, or
lean on **global search**, which doesn't care where you are.

## Setup (once)

Requires Bun ≥ 1.2 and PostgreSQL 16 + pgvector ≥ 0.7.

```bash
docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vectors \
  -p 5432:5432 pgvector/pgvector:pg16
export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors

bun install                 # dependencies
vectors setup               # apply the schema + migrations + default embedding space
vectors setup --link        # ...also link the global `vectors` / `vindex` bin (bun link)
vectors setup --daemon      # ...also install the background daemon
vectors doctor              # verify Bun, DSN, Postgres, pgvector, schema, daemon
```

The global config/cache home is `$VINDEX_HOME` (default
`~/.local/share/vector-index`); **vectors live in Postgres**, not on disk. Models
cache under `~/.cache/huggingface`. Override models with
`$VINDEX_EMBED_MODEL` / `$VINDEX_RERANK_MODEL`.

## Core workflow

Always **create a project → add sources → ingest → query**. Pick the chunking
strategy to match the corpus (`markdown`, `code`, `text`, or `auto` per
extension). A project over a local directory is rooted there so auto-resolution
works immediately.

```bash
# 1. index the project you're standing in (root defaults to the cwd)
cd ~/Documents/Projects/scene
vectors project create scene --root .
vectors project add-source scene --id code --path . --glob '**/*.ts' --glob '**/*.md'
vectors project ingest scene            # incremental; project resolved from cwd
vectors query "how does the flock pick ideas?"

# 2. a folder of notes
vectors project create notes --root ~/Documents/notes
vectors project add-source notes --path ~/Documents/notes --glob '**/*.md'
vectors project ingest notes

# 3. a git repo, with public URLs reconstructed for each hit
vectors project add-source rustbook --type repo --path ~/src/book \
  --glob '**/*.md' --base-url 'https://doc.rust-lang.org/book/{path}.html'
vectors project ingest rustbook

# ask across EVERY project at once (the global context)
vectors search "welded indexed geometry deterministic seed"

# housekeeping
vectors projects        # all projects + doc/chunk counts (* = active)
vectors here            # which project does this dir resolve to?
vectors status scene    # config + stats
vectors reindex scene   # wipe + rebuild
vectors serve  scene    # 3D viewer → http://localhost:7341
vectors viewer export scene.html   # standalone viewer (no server)
```

Add `--no-rerank` for raw fused order (faster, skips the cross-encoder), `--json`
for machine-readable output, and on `search` use `--projects a,b` to scope to a
subset. `vectors repl` is a query-first interactive shell (bare line = search the
current project; `:project NAME`, `:global Q`, `:help`, `:quit`).

## AST + symbol-graph ingestion

Code files are chunked by **tree-sitter** into **one chunk per named
declaration**: functions/methods → `unit_type='symbol'`; classes/interfaces/
types/enums/consts → `unit_type='definition'`, each titled by the symbol name
(`src/geo.ts › seedMesh`). Imports are persisted as `reference(kind='file')` rows
+ `link(relation='mentions')` edges — an **import graph** in the same store.
Supported: ts, tsx, js, py, go, rust, java, c, cpp, ruby, php, c#, swift, kotlin,
scala, lua. Unsupported languages / parse failures fall back to the line-window
chunker.

## Hybrid search

Each query runs a **dense** leg (pgvector cosine ANN over HNSW) and a **sparse**
leg (Postgres `tsvector`/`ts_rank` FTS), fused with **Reciprocal Rank Fusion**,
then a **cross-encoder rerank**. Results carry a `confidence` tier
(high/medium/low) derived from retrieval strength + signal agreement, and each
hit a `unit_type`. Citations/claims can be validated against the corpus
(`validate_citations` flags unverifiable refs `[UNVERIFIED]`).

## MCP server

`vectors mcp` runs the stdio server; `bash install.sh` wires it into every
detected harness (the bundled `.mcp.json` points plugin installs at
`bun ${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts`). 13 tools:

- **search** `(query, project?, topk?, rerank?)` — one project, hybrid+reranked.
- **search_global** `(query, topk?, rerank?, projects?)` — across all/subset.
- **current_project** `()` · **list_projects** `()` · **project_status** `(project?)`
- **ingest** `(project?)` · **reindex** `(project?)`
- **create_project** `(name, root?, embed_model?, rerank_model?)`
- **add_source** `(path, project?, id?, type?, globs?, base_url?)`
- **validate_citations** `(text, project?, topk?)` — ground claims against the corpus.
- **resolve_reference** `(uri, network?)` — resolve a URI/citation (optional HEAD).
- **recall_intents** `(query, project?, topk?)` · **resolve_intent** `(intent, outcome, score?, project?)`

`project` auto-resolves from cwd when omitted. Mutating tools honor
`VINDEX_READONLY` / `VINDEX_ALLOW_ROOTS`.

For Claude Desktop (no stable cwd) pin a project:

```jsonc
"vectors": {
  "command": "bun",
  "args": ["/abs/path/src/mcp/server.ts"],
  "env": { "VINDEX_PROJECT": "scene" }   // omit to rely on search_global
}
```

## Intent memory (conversation-learning hooks)

Beyond indexing files, the plugin learns from the *conversation*. Claude Code
hooks (`hooks/hooks.json`, wired via the plugin manifest) record what you ask,
how often a similar thing recurs, the assistant's response, and whether it
resolved your intent — then inject prior known resolutions (and failures to
avoid) into context *before* the next reply.

- **Store**: the Postgres `intent` / `intent_resolution` tables (deterministic
  intent id `"i"+sha256(normalized)[:30]`). No daemon required.
- **Recall is fast & model-free**: `UserPromptSubmit` does an exact-id + lexical
  Jaccard lookup (current project preferred, global fallback) and injects in
  milliseconds; the write happens in a detached process.
- **Grading**: `Stop` grades the finished exchange with a **local Ollama judge**
  when reachable, else a transcript heuristic (a re-ask ⇒ unresolved, acceptance
  ⇒ resolved).
- **CLI / MCP**: `vectors intent record|recall|resolve|grade|stats`; MCP tools
  `recall_intents` and `resolve_intent`.

```bash
vectors intent recall "reset the dev database"     # what worked before?
vectors intent stats                               # frequency leaderboard
vectors intent resolve "reset the dev database" resolved
```

Toggles: `VINDEX_INTENT_DISABLE=1` (hooks become no-ops),
`VINDEX_INTENT_NO_JUDGE=1` (skip Ollama, heuristic only),
`VINDEX_INTENT_MIN_SCORE` (inject threshold, default 0.45),
`VINDEX_INTENT_MAX_TOKENS` (injection budget, default 400). Honors
`VINDEX_READONLY`.

## Background daemon

A single long-lived service (launchd / systemd `--user`) keeps the store current:
a **chat feeder** (mirrors Claude transcripts into `session`/`message`), a
**source feeder** (re-ingests changed files), and a **digest worker** (embeds new
content via `LISTEN/NOTIFY` + poll, runs optional local-Ollama summaries / fact
extraction). The searchable path never needs Ollama. Manage with
`vectors daemon install | run | status | restart | logs | uninstall`. See
[`daemon/README.md`](daemon/README.md).

## Bundled files

- `src/cli/` — the `vectors` CLI (registry + commands + REPL).
- `src/db/` — pool, schema/migrations, project registry + cwd resolution, ingest.
- `src/chunk/` — chunker (md/code/text), `ast.ts` (tree-sitter symbol chunks +
  import graph), `units.ts` (`unit_type` classifier).
- `src/embed/` — embedder + cross-encoder rerank (Transformers.js / ONNX).
- `src/search/` — hybrid search, grounding/confidence, references/citations,
  token-budget assembly, Bridge-pattern orchestration.
- `src/intents/store.ts` — Postgres-backed intent memory.
- `src/daemon/` — supervisor + chat/source feeders + digest worker.
- `src/mcp/server.ts` — stdio MCP server (13 tools).
- `src/viewer/` — 3D synapse viewer HTTP + JSON API (PCA); `make_demo.ts` bakes a
  standalone demo.
- `hooks/` — `user_prompt_submit.ts` (recall + inject), `stop.ts` (grade).
- `assets/viewer.html` — 3D synapse navigator (server-backed, baked, or demo mode).
- `references/architecture.md` — internals & extension points.
- `references/unified-knowledge-db-spec.md` + `unified-knowledge-db.sql` — the
  full unified-store design + DDL.
- `daemon/` — background daemon service tooling (`install.sh`, env example,
  launchd plist template); see `daemon/README.md`.
- `../../spec.md` (repo root) — the exhaustive system specification.
