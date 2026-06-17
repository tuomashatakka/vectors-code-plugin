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

```bash
# 1. build the skill's venv (creates skills/vector-index/.venv)
cd skills/vector-index && bash setup.sh && cd -
```

Then make it discoverable in each tool. The skill is symlinked into each tool's
skills directory; the MCP server is registered in each tool's MCP config.

- **Claude Code** — skill symlinked to `~/.claude/skills/vector-index`; MCP via
  the bundled `.mcp.json` (when installed as a plugin) or `claude mcp add`.
- **opencode** — skill symlinked to `~/.config/opencode/skills/vector-index`;
  MCP registered in `~/.config/opencode/opencode.json`.
- **Claude Desktop** — no skills directory, so integration is the MCP server in
  `~/Library/Application Support/Claude/claude_desktop_config.json`.

MCP tools: `search`, `search_global`, `current_project`, `list_projects`,
`project_status`, `ingest`, `reindex`, `create_project`, `add_source`.

## Usage

See [`skills/vector-index/SKILL.md`](skills/vector-index/SKILL.md) and
[`skills/vector-index/references/architecture.md`](skills/vector-index/references/architecture.md).

```bash
PY=skills/vector-index/.venv/bin/python
$PY skills/vector-index/scripts/vindex.py create scene --source ~/Documents/Projects/scene --strategy code
$PY skills/vector-index/scripts/vindex.py ingest scene
$PY skills/vector-index/scripts/vindex.py search "deterministic seeded geometry"
```
