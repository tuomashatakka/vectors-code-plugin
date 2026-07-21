---
name: vector-index
description: A emantic RAG store partitioned by PROJECT. One store on disk; every project is its own embedded + cross-encoder-reranked index, and the active project is auto-resolved from the working directory (so an agent working inside a repo just gets that repo's retrieval, hsci-style). Supports per-project search AND global cross-project search that merges + reranks hits from every project. Use this whenever the user wants to "search my docs/notes/ codebase", build a local RAG / retrieval index, "index this project", give a local LLM or agent grounded project-scoped retrieval, set up a vector DB over files, ask questions across one repo or across all their projects, or wire semantic search into an MCP — even if they don't say the word "vector". Trigger on phrases like "semantic search over X", "index this repo", "RAG for my projects", "search across all my projects", "vector DB keyed by project", "what did we decide in project", or "let the agent search the current project".
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

Requires Bun ≥ 1.2 and PostgreSQL 16 + pgvector ≥ 0.7. One command provisions all
of it — Bun, Postgres + pgvector, the schema, the global `vectors` CLI, the
daemon, and editor/MCP wiring — with **no Docker**:

```bash
bash setup.sh               # full install (Homebrew on macOS / apt on Linux)
bash setup.sh --no-db       # skip Postgres provisioning (use an existing $VINDEX_DSN)
vectors doctor              # verify Bun, DSN, Postgres, pgvector, schema, daemon
vectors db                  # every table with row counts + size
vectors db intent --limit 5 --order frequency --desc
```

The global config/cache home is `$VINDEX_HOME` (default
`~/.local/share/vector-index`); **vectors live in Postgres**, not on disk. Models
cache under `~/.cache/huggingface`. Override models with
`$VINDEX_EMBED_MODEL` / `$VINDEX_RERANK_MODEL`.

## Core workflow

**Index a project in one command** — `vectors index <name> [path]` creates the
project, attaches the source, and ingests it (incremental diff-by-hash). The root
defaults to the cwd and a Git `origin` remote becomes the citation-URL template;
re-run any time for an incremental update, `--rebuild` wipes first.

```bash
# 1. index the project you're standing in (root = cwd)
cd ~/Documents/Projects/scene
vectors index scene
vectors search "how does the flock pick ideas?"   # current project

# 2. a folder of notes — explicit path + globs
vectors index notes ~/Documents/notes --glob '**/*.md'

# 3. a repo with public URLs reconstructed for each hit
vectors index rustbook ~/src/book --glob '**/*.md' \
  --url 'https://doc.rust-lang.org/book/{path}'

# ask across EVERY project at once (the global context)
vectors search --global "welded indexed geometry deterministic seed"

# housekeeping
vectors ls              # all projects + doc/chunk counts (* = active)
vectors ls scene        # one project's config + stats
vectors index scene --rebuild      # wipe + rebuild
vectors viewer                     # live 3D viewer → http://localhost:7341
vectors viewer --all               # serve the `*` all-projects scope
```

Add `--no-rerank` for raw fused order (faster, skips the cross-encoder), `--json`
for machine-readable output, and on `search` use `--projects a,b` to scope global
search to a subset (or prefix the query with `all:`). Run **`vectors`** with no
arguments for the interactive TUI (command autocomplete, Ctrl-P project switcher,
query-first prompt).

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

`vectors mcp` runs the stdio server; `bash setup.sh` wires it into every
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

### Remote (streamable HTTP)

`vectors mcp http` serves the same 13 tools over the MCP **streamable-HTTP**
transport — for reverse-proxy or remote deployments (e.g. nginx `/mcp`).
Stateless (a fresh server per request), bound to
`127.0.0.1:$VINDEX_MCP_HTTP_PORT` (alias `PORT`, default `8765`):
`POST/GET/DELETE /mcp`, plus `GET /health` → `ok`.

```jsonc
// Claude Code / VS Code:  { "type": "http",   "url": "https://srv1697915.hstgr.cloud/mcp" }
// opencode:               { "type": "remote", "url": "https://srv1697915.hstgr.cloud/mcp" }
// Claude Desktop:         { "command": "npx", "args": ["mcp-remote", "https://srv1697915.hstgr.cloud/mcp"] }
```

Like Claude Desktop, an HTTP client has no stable cwd — the server resolves
projects from *its own* cwd, so pin `VINDEX_PROJECT` per deployment or lean on
`search_global`.

## Intent memory (conversation-learning hooks)

Beyond indexing files, the plugin learns from the *conversation*. Hooks in
Claude Code, Codex, and Antigravity/Gemini (`hooks/hooks.json` via the plugin
manifest, or merged into each harness config by `setup.sh`) record what you ask,
how often a similar thing recurs, the assistant's response, and whether it
resolved your intent — then inject prior known resolutions (and failures to
avoid) into context *before* the next reply.

- **Store**: the Postgres `intent` / `intent_resolution` tables (deterministic
  intent id `"i"+sha256(normalized)[:30]`). No daemon required.
- **Recall is fast & model-free**: the pre-prompt hook (`UserPromptSubmit`, or
  `BeforeAgent` on Gemini) does an exact-id + lexical Jaccard lookup (current
  project preferred, global fallback) and injects in milliseconds; the write
  happens in a detached process.
- **Grading**: the post-turn hook (`Stop`, or `AfterAgent` on Gemini) grades the
  finished exchange with a **local Ollama judge**
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
a **chat feeder** (mirrors Claude, Codex, and Gemini transcripts into
`session`/`message`), a
**source feeder** (re-ingests changed files), and a **digest worker** (embeds new
content via `LISTEN/NOTIFY` + poll, runs optional local-Ollama summaries / fact
extraction). The searchable path never needs Ollama. Manage with
`vectors daemon start | stop | status | logs`. See
[`daemon/README.md`](daemon/README.md).

## Bundled files

- `src/cli/` — the `vectors` CLI (registry + commands + opentui interactive TUI).
- `src/db/` — pool, schema/migrations, project registry + cwd resolution, ingest.
- `src/chunk/` — chunker (md/code/text), `ast.ts` (tree-sitter symbol chunks +
  import graph), `units.ts` (`unit_type` classifier).
- `src/embed/` — embedder + cross-encoder rerank (Transformers.js / ONNX).
- `src/search/` — hybrid search, grounding/confidence, references/citations,
  token-budget assembly, Bridge-pattern orchestration.
- `src/intents/store.ts` — Postgres-backed intent memory.
- `src/daemon/` — supervisor + chat/source feeders + digest worker.
- `src/mcp/server.ts` — stdio MCP server (13 tools).
- `src/viewer/` — 3D synapse viewer: `server.ts` (HTTP + JSON API, PCA via
  `ml-pca`) + `static.ts` (traversal-safe static asset serving, `/vendor/three/*`).
- `hooks/` — `user_prompt_submit.ts` (recall + inject), `stop.ts` (grade); wired
  into Claude Code, Codex, and Antigravity.
- `assets/viewer/` — 3D synapse navigator front-end (`index.html` + `viewer.css` +
  ES modules under `js/`), served live by `src/viewer/server.ts`; mirrored into
  `skills/vector-index/assets/viewer/` by `scripts/sync-assets.ts`.
- `references/architecture.md` — internals & extension points.
- `references/unified-knowledge-db-spec.md` + `unified-knowledge-db.sql` — the
  full unified-store design + DDL.
- `daemon/` — background daemon service tooling (`install.sh`, env example,
  launchd plist template); see `daemon/README.md`.
- `../../spec.md` (repo root) — the exhaustive system specification.
