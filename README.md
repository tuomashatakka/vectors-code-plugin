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
project at once. Use it from the CLI, the MCP server, the Python library, or the
3D viewer. An optional background daemon keeps everything re-ingested for you.

It also **learns from the conversation**: Claude Code hooks record each user
intent, how often similar asks recur, the assistant's response, and whether it
resolved the intent — then inject prior known resolutions (and failures to avoid)
into context before the next reply. The intent memory is local-first SQLite
(`$VINDEX_HOME/__intents__/`), recall is a fast model-free lexical lookup, and
grading uses a local Ollama judge (with a transcript heuristic fallback). See
**Intent memory** in the skill docs; toggle off with `VINDEX_INTENT_DISABLE=1`.

## What's inside

```
vectors-plugin/
├── .claude-plugin/plugin.json   plugin manifest
├── .mcp.json                    bundled MCP server (the "vectors" tools)
├── commands/vectors.md          /vectors slash command
└── skills/
    └── vector-index/            the skill (SKILL.md + scripts + assets + refs)
```

## Install

One command builds the venv, symlinks the skill, and registers the `vectors`
MCP server into every supported harness/LLM application it finds:

```bash
bash install.sh                 # build + wire everything; asks about the daemon
bash install.sh --no-daemon     # ...build + wire only, skip the background daemon
bash install.sh --yes           # ...non-interactive, daemon included
```

It's idempotent — re-run any time. Reverse it with `bash uninstall.sh` (add
`--venv` to also drop the venv, `--daemon` to remove the background service).
The on-disk store at `$VINDEX_HOME` is always left intact.

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

## Scripts (pnpm)

`package.json` is a thin task runner over the Python/bash tooling (no JS
dependencies). Initialize once, then drive everything through `pnpm`:

```bash
pnpm install                 # initialize the workspace (zero JS deps)
pnpm setup                   # build the skill venv + deps (wraps setup.sh)
pnpm wire                    # wire every detected editor (wraps install.sh); :all / :no-daemon variants
pnpm unwire                  # reverse it (wraps uninstall.sh)

pnpm projects                # list indexed projects (* = active)
pnpm ingest <project>        # (re)ingest a project's sources
pnpm search "<query>"        # global search across every project
pnpm query <project> "<q>"   # search one project
pnpm serve <project>         # 3D viewer -> http://localhost:7341
pnpm export-viewer <project> # standalone viewer HTML (no server)
pnpm digest [parent-dir]     # create + ingest every immediate child dir
                             #   (default ~/Documents/Projects; idempotent; skips giant repos)

pnpm daemon:install          # install the background sync daemon
pnpm daemon:restart          # force a fresh sweep (launchd kickstart)
pnpm daemon:logs             # tail the daemon log
pnpm test                    # run the Python test suite
```

pnpm forwards arguments straight to the underlying command, e.g.
`pnpm serve scene --port 8080` or `pnpm ingest scene --rebuild`.

## Usage

See [`skills/vector-index/SKILL.md`](skills/vector-index/SKILL.md) and
[`skills/vector-index/references/architecture.md`](skills/vector-index/references/architecture.md).

```bash
PY=skills/vector-index/.venv/bin/python
$PY skills/vector-index/scripts/vindex.py create scene --source ~/Documents/Projects/scene --strategy code
$PY skills/vector-index/scripts/vindex.py ingest scene
$PY skills/vector-index/scripts/vindex.py search "deterministic seeded geometry"
```
