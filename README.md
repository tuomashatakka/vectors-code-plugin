# vectors-plugin

A Claude Code / Codex / opencode / Claude Desktop / VS Code / Antigravity plugin
that ships a **global, local,
project-partitioned semantic RAG store** — the `vector-index` skill plus an MCP
server exposing it as live tools.

One store on disk holds many **projects**; each is its own embedded +
cross-encoder-reranked index. The active project is **auto-resolved from the
working directory**, so an agent working inside a repo gets that repo's
retrieval automatically. You can also search **globally** across every project
at once. Everything runs locally: no API keys, no network at query time.

```
$VINDEX_HOME            one global RAG database
  ├── scene/            a project (own collection + config + root)
  ├── portfolio/
  └── rustbook/
```

## How it works

![vector-index usage flow](docs/flow.svg)

Index a project once; then query it — per project, or globally across every
project at once. Use it from the CLI, the MCP server, or the 3D viewer. An
optional background daemon keeps everything re-ingested for you.

Implemented in **TypeScript, run directly on [Bun](https://bun.sh)** (no build
step), with embeddings from **Transformers.js** (`all-MiniLM-L6-v2`, 384-dim,
fully local — no PyTorch) and storage in **PostgreSQL + pgvector**.

It also **learns from the conversation**: Claude Code hooks record each user
intent, how often similar asks recur, the assistant's response, and whether it
resolved the intent — then inject prior known resolutions (and failures to avoid)
into context before the next reply. The intent memory lives in the same Postgres
store (`intent` / `intent_resolution`), recall is a fast model-free lexical lookup, and
grading uses a local Ollama judge (with a transcript heuristic fallback). See
**Intent memory** in the skill docs; toggle off with `VINDEX_INTENT_DISABLE=1`.

## What's inside

```
vectors-plugin/
├── .claude-plugin/plugin.json   plugin manifest
├── .mcp.json                    bundled MCP server (bun src/mcp/server.ts)
├── commands/vectors.md          /vectors slash command
├── src/                         TypeScript engine: db, embed, chunk, search, cli, mcp, viewer, daemon
├── hooks/                       UserPromptSubmit + Stop hooks (intent memory)
├── references/                  unified-knowledge-db.sql + design docs
└── skills/
    └── vector-index/            SKILL.md + assets + references
```

## Install

One command installs dependencies (bun), symlinks the skill, and registers the
`vectors` MCP server into every supported harness/LLM application it finds:

```bash
bash install.sh                 # install + wire everything; asks about the daemon
bash install.sh --no-daemon     # ...install + wire only, skip the background daemon
bash install.sh --yes           # ...non-interactive, daemon included
```

It's idempotent — re-run any time. Reverse it with `bash uninstall.sh` (add
`--deps` to also drop `node_modules`, `--daemon` to remove the background service).
The Postgres store is always left intact.

What it wires per tool (from the shared, data-driven environment registry in
`scripts/environments.sh`):

- **Claude Code** — skill → `~/.claude/skills/vector-index`, `/vectors` command →
  `~/.claude/commands/`; MCP via the bundled `.mcp.json` (plugin installs) or
  `claude mcp add` (user scope).
- **Codex** — skill → `~/.codex/skills/vector-index` (or
  `$CODEX_HOME/skills/vector-index`), `/vectors` command →
  `~/.codex/commands/` (or `$CODEX_HOME/commands/`).
- **opencode** — skill → `~/.config/opencode/skills/vector-index`, `/vectors`
  command → `~/.config/opencode/command/`; MCP entry in
  `~/.config/opencode/opencode.json`.
- **Claude Desktop** — no skills dir, so just the MCP server in
  `~/Library/Application Support/Claude/claude_desktop_config.json` (relies on
  global search — it has no fixed working directory).
- **VS Code** — no skills dir; MCP server registered in
  `~/Library/Application Support/Code/User/mcp.json` (a `servers` entry with
  `stdio` transport). Restart VS Code to pick it up.
- **Antigravity** — skill → `~/.gemini/skills/vector-index`; MCP server written to
  `~/.antigravity/mcp_config.json` and the `~/.gemini/{config,antigravity,antigravity-ide}/mcp_config.json`
  variants (Antigravity's config path varies by version, so all are covered).

MCP tools: `search`, `search_global`, `current_project`, `list_projects`,
`project_status`, `ingest`, `reindex`, `create_project`, `add_source`,
`validate_citations`, `resolve_reference`, `recall_intents`, `resolve_intent`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 (the runtime — runs the TypeScript directly)
- PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) ≥ 0.7

Spin up a local database in one line:

```bash
docker run -d --name vectors-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vectors \
  -p 5432:5432 pgvector/pgvector:pg16
export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors
```

## Scripts (bun)

Drive everything through `bun run <script>` (the `package.json` scripts):

```bash
bun install                  # install dependencies
bun run schema               # apply the unified-knowledge-db schema to $VINDEX_DSN
bun run wire                 # wire every detected editor (install.sh); :all / :no-daemon variants
bun run unwire               # reverse it (uninstall.sh)

bun run projects             # list indexed projects (* = active)
bun run ingest <project>     # (re)ingest a project's sources
bun run search "<query>"     # global search across every project
bun run query <project> "<q>"# search one project
bun run serve <project>      # 3D viewer -> http://localhost:7341
bun run export-viewer        # standalone demo viewer HTML (no server)

bun run daemon               # run the background sync daemon in the foreground
bun run daemon:install       # install it as a launchd/systemd service
bun run lint                 # eslint (zero warnings enforced)
bun run typecheck            # tsc --noEmit
bun test                     # run the test suite
```

## Usage

See [`skills/vector-index/SKILL.md`](skills/vector-index/SKILL.md) and
[`skills/vector-index/references/architecture.md`](skills/vector-index/references/architecture.md).

```bash
export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors
bun src/cli.ts create scene --root ~/Documents/Projects/scene
bun src/cli.ts add-source scene --id code --path ~/Documents/Projects/scene --glob '**/*.ts'
bun src/cli.ts ingest scene
bun src/cli.ts query "deterministic seeded geometry" --project scene
```
