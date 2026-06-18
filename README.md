# vectors-plugin

A Claude Code / opencode / Claude Desktop plugin that ships a **global, local,
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
MCP server into every tool it finds:

```bash
bash install.sh                 # build + wire everything; asks about the daemon
bash install.sh --no-daemon     # ...build + wire only, skip the background daemon
bash install.sh --yes           # ...non-interactive, daemon included
```

It's idempotent — re-run any time. Reverse it with `bash uninstall.sh` (add
`--venv` to also drop the venv, `--daemon` to remove the background service).
The on-disk store at `$VINDEX_HOME` is always left intact.

What it wires per tool:

- **Claude Code** — skill → `~/.claude/skills/vector-index`, `/vectors` command →
  `~/.claude/commands/`; MCP via the bundled `.mcp.json` (plugin installs) or
  `claude mcp add` (user scope).
- **opencode** — skill → `~/.config/opencode/skills/vector-index`, `/vectors`
  command → `~/.config/opencode/command/`; MCP entry in
  `~/.config/opencode/opencode.json`.
- **Claude Desktop** — no skills dir, so just the MCP server in
  `~/Library/Application Support/Claude/claude_desktop_config.json` (relies on
  global search — it has no fixed working directory).

MCP tools: `search`, `search_global`, `current_project`, `list_projects`,
`project_status`, `ingest`, `reindex`, `create_project`, `add_source`,
`validate_citations`, `resolve_reference`.

## Usage

See [`skills/vector-index/SKILL.md`](skills/vector-index/SKILL.md) and
[`skills/vector-index/references/architecture.md`](skills/vector-index/references/architecture.md).

```bash
PY=skills/vector-index/.venv/bin/python
$PY skills/vector-index/scripts/vindex.py create scene --source ~/Documents/Projects/scene --strategy code
$PY skills/vector-index/scripts/vindex.py ingest scene
$PY skills/vector-index/scripts/vindex.py search "deterministic seeded geometry"
```
