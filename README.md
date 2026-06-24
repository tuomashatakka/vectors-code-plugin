# vectors-plugin

A Claude Code / Codex / opencode / Claude Desktop / VS Code / Antigravity plugin
that ships a **global, local, project-partitioned semantic RAG store** — the
`vector-index` skill plus an MCP server exposing it as live tools.

One PostgreSQL + pgvector database holds many **projects**; each is its own
embedded + cross-encoder-reranked index. The active project is **auto-resolved
from the working directory**, so an agent working inside a repo gets that repo's
retrieval automatically. You can also search **globally** across every project at
once. Everything runs locally: **no API keys, no network at query time, no
Python** — embeddings and reranking are pure JS/WASM (`@xenova/transformers`,
ONNX), run directly on [Bun](https://bun.sh) with no build step.

```
VINDEX_DSN              one PostgreSQL + pgvector database
  ├── scene/            a project (own documents + chunks + vectors + root)
  ├── portfolio/
  └── rustbook/
```

It also **learns from the conversation**: Claude Code hooks record each user
intent, how often similar asks recur, the assistant's response, and whether it
resolved the intent — then inject prior known resolutions (and failures to
avoid) into context before the next reply. Recall is a fast, model-free lexical
lookup; grading uses a local Ollama judge with a transcript-heuristic fallback.
Toggle off with `VINDEX_INTENT_DISABLE=1`.

> **Full specification:** [`spec.md`](spec.md) — exhaustive data model, retrieval
> pipeline, daemon, MCP tools, CLI, and config.

## Headline feature: AST + symbol-graph ingestion

Code files are chunked by **tree-sitter** into **one chunk per named
declaration** — functions/methods become `symbol` units, classes/interfaces/
types/enums/consts become `definition` units — each titled by its symbol name
(e.g. `src/geo.ts › seedMesh`). Imports are persisted as
`reference(kind='file')` + `mentions` link edges, giving you an **import graph**
in the same store. Supported: ts, tsx, js, py, go, rust, java, c, cpp, ruby, php,
c#, swift, kotlin, scala, lua (via `web-tree-sitter` + `tree-sitter-wasms`, pure
JS/WASM). Unsupported languages fall back to the line-window chunker.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 (runs the TypeScript directly — no build step)
- PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) ≥ 0.7

`setup.sh` installs both for you (Homebrew on macOS, apt on Linux) — see
**Install**. **No Docker required.** If you already run Postgres, just point
`VINDEX_DSN` at it:

```bash
export VINDEX_DSN=postgres://localhost:5432/vectors
```

## Install

One command provisions **everything** — Bun, PostgreSQL 16 + pgvector, the
schema, the global `vectors` CLI, the background daemon, and MCP/skill wiring for
every detected editor. **No Docker.**

```bash
bash setup.sh                   # full install (prompts before the daemon)
bash setup.sh --yes             # non-interactive (daemon included)
bash setup.sh --no-daemon       # everything except the daemon
bash setup.sh --no-db           # skip Postgres provisioning (use existing $VINDEX_DSN)
vectors doctor                  # verify Bun, DSN, Postgres, pgvector, schema, daemon
```

It is idempotent; reverse the editor/MCP wiring + daemon with `bash setup.sh
--uninstall` (the Postgres store is left intact). `vectors setup` on its own just
(re)applies the schema + default embedding space to `$VINDEX_DSN`.

## Usage

Index a whole project in **one command** — it creates the project, attaches the
source, and ingests it (incremental, diff-by-hash). The root defaults to the cwd
and a Git `origin` remote becomes the citation-URL template, so the common case
needs no flags:

```bash
# index the project you're standing in
cd ~/Documents/Projects/scene
vectors index scene                        # root = cwd; git remote → blob URLs

# or point at a path with explicit globs; re-run anytime → incremental re-ingest
vectors index scene ~/Documents/Projects/scene \
  --glob '**/*.ts' --glob '**/*.md'
vectors index scene --rebuild              # wipe + rebuild from scratch

# search the current project (hybrid dense+lexical, reranked)
vectors search "deterministic seeded geometry"

# search ACROSS every project (or a subset), merged + reranked
vectors search --global "welded indexed geometry deterministic seed"
vectors search "RRF fusion" --projects scene,rustbook --json
# (an `all:` query prefix also forces global)

# list projects (* = active); pass a name for its config + stats
vectors ls
vectors ls scene
```

`--no-rerank` gives raw fused order (faster, skips the cross-encoder); `--json`
emits machine-readable output. The project is auto-resolved from the cwd when
omitted.

### Interactive shell

Run `vectors` with no arguments to open the **interactive TUI** (built on
`opentui`): command autocomplete over the registry, a project switcher (Ctrl-P),
and a query-first prompt — a bare line searches the active project.

```bash
vectors                         # autocomplete · Ctrl-P switch · :project NAME · :help · :q
```

### Background daemon

Keeps the store current: a **chat feeder** (mirrors Claude transcripts into
`session`/`message`), a **source feeder** (re-ingests changed files), and a
**digest worker** (embeds new content; optional local-Ollama summaries / fact
extraction). Install as a service (launchd on macOS, systemd `--user` on Linux):

```bash
vectors daemon start            # install + start the service
vectors daemon stop             # stop + remove it
vectors daemon status | logs
```

### Editors / MCP

`bash setup.sh` wires the bundled `vectors` MCP server into every harness it
finds (skill + `/vectors` command + MCP entry). MCP tools:

`search`, `search_global`, `current_project`, `list_projects`, `project_status`,
`ingest`, `reindex`, `create_project`, `add_source`, `validate_citations`,
`resolve_reference`, `recall_intents`, `resolve_intent`.

Run the server standalone with `vectors mcp` (the bundled `.mcp.json` points
plugin installs at `bun ${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts`).

### 3D viewer

```bash
vectors viewer                  # static HTML, every project baked in → docs/vectors-viewer.html
vectors viewer --serve scene    # live server → http://localhost:7341
```

A three.js "synapse" navigator that PCAs each project's embedding space to 3D and
links nearest neighbours; type to search, drag to orbit. The static export is a
single self-contained file with a **project picker** — open it straight from
`file://`, no server process. `--serve` streams fresh, unsampled data and the
same picker switches projects live.

## Environment variables

`VINDEX_*` is canonical; legacy `UKDB_*` names are accepted as deprecated
aliases.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VINDEX_DSN` (alias `UKDB_DSN`) | `postgres://localhost:5432/vectors` | Postgres DSN. |
| `VINDEX_HOME` | `~/.local/share/vector-index` | Config + cache home (vectors live in Postgres). |
| `VINDEX_EMBED_MODEL` | `all-MiniLM-L6-v2` | Embedding model (384-d). |
| `VINDEX_RERANK_MODEL` | `cross-encoder/ms-marco-MiniLM-L6-v2` | Cross-encoder reranker. |
| `VINDEX_PROJECT` | (unset) | Pin the active project (wins over cwd resolution). |
| `VINDEX_DEFAULT` | `default` | Fallback project name. |
| `VINDEX_READONLY` | off | Block all mutating operations. |
| `VINDEX_ALLOW_ROOTS` | (none) | `:`-separated roots allowed for ingest/create. |
| `VINDEX_INTENT_DISABLE` | off | Disable the intent-memory hooks. |
| `VINDEX_INTENT_NO_JUDGE` | off | Skip the Ollama judge (heuristic grading only). |
| `VINDEX_INTENT_MIN_SCORE` | `0.45` | Recall inject threshold. |
| `VINDEX_INTENT_MAX_TOKENS` | `400` | Injection token budget. |
| `VINDEX_OLLAMA_URL` (alias `OLLAMA_URL`) | `http://127.0.0.1:11434` | Local Ollama (judge / digest). |
| `VINDEX_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model. |
| `VINDEX_CHAT_GLOBS` (alias `UKDB_CHAT_GLOBS`) | `~/.claude/projects/**/*.jsonl` | Transcript globs (daemon chat feeder). |
| `VINDEX_CHAT_INTERVAL` / `VINDEX_SOURCE_INTERVAL` | `5` / `300` (s) | Feeder cadences. |
| `VINDEX_VIEWER_PORT` (alias `PORT`) | `7341` | 3D viewer port. |

## Architecture

```
src/
  cli/          command registry + dispatch + interactive TUI (tui.ts, opentui)
  db/           pool, schema/migrations, project registry + cwd resolution, ingest
  chunk/        chunker (md/code/text), ast.ts (tree-sitter symbol chunks + import graph), units
  embed/        embedder (mean-pool + L2-norm) + cross-encoder rerank — pure JS/WASM (ONNX)
  search/       hybrid dense+sparse RRF + rerank + confidence; grounding, references, assemble, orchestration
  intents/      Postgres-backed intent memory (record/recall/resolve/grade)
  daemon/       supervisor + chat/source feeders + digest worker
  mcp/          stdio MCP server (13 tools)
  viewer/       3D synapse viewer HTTP + JSON API (PCA)
hooks/          UserPromptSubmit + Stop hooks (intent memory)
references/     unified-knowledge-db.sql (full DDL) + design docs
skills/vector-index/   SKILL.md, daemon tooling, viewer asset, reference docs
```

Pipeline: **per-project** `files → chunk → embed → store` (ingest, incremental
diff-by-hash), then `query → embed → dense+sparse → RRF → cross-encoder rerank`
(offline). **Global** search fans out across projects, merges, and applies one
rerank so hits are comparable even across embedding models.

## Scripts

```bash
bun run typecheck     # tsc --noEmit
bun run lint          # eslint (zero warnings enforced)
bun test              # bun test
bun run wire          # bash setup.sh
bun run unwire        # bash setup.sh --uninstall
bun run demo-viewer   # regenerate docs/viewer-demo.html (procedural demo)
```

See [`spec.md`](spec.md) for the complete specification and
[`skills/vector-index/SKILL.md`](skills/vector-index/SKILL.md) for the skill
docs. MIT licensed.
