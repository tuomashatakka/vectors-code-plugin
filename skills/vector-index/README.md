# vector-index

A global, local **semantic RAG store, partitioned by project**. One PostgreSQL +
pgvector database holds many projects; each is its own embedded +
cross-encoder-reranked index, and the active project is **auto-resolved from your
working directory**. Search a single project or go **global** across every
project at once. All local: no API keys, no network at query time, **no Python**
(embeddings + reranking are ONNX via Transformers.js, run on Bun).

```
VINDEX_DSN              one PostgreSQL + pgvector database
  ├── scene/            a project (documents + chunks + vectors + root)
  ├── portfolio/        another project
  └── rustbook/         …
```

## Quick start

Requires Bun ≥ 1.2 and PostgreSQL 16 + pgvector ≥ 0.7.

```bash
export VINDEX_DSN=postgres://localhost:5432/vectors   # any Postgres 16 + pgvector
bun install
vectors setup                                  # apply schema + default embedding space

# index the project you're standing in (create + attach + ingest, one step; root = cwd)
cd ~/Documents/Projects/scene
vectors index scene
vectors search "how does the flock pick ideas?"

# ask across every project
vectors search --global "welded indexed geometry deterministic seed"

vectors ls                                     # all projects (* = active)
vectors viewer scene                           # 3D viewer at http://localhost:7341
```

From the repo root, `bash setup.sh` provisions Postgres + pgvector and the global
CLI for you — **no Docker**.

## Interfaces

| Use | Entry |
| --- | --- |
| Index / search / global search / viewer / daemon | `vectors` CLI |
| Interactive shell (autocomplete + Ctrl-P project switcher) | bare `vectors` |
| Live project-aware tools for Claude / an agent | `vectors mcp` (stdio MCP, 13 tools) |
| Explore one project's space | `vectors viewer` → 3D viewer |

## MCP

```bash
vectors mcp     # run the stdio server; `bash ../../setup.sh` wires it into editors
```

For a server with no stable cwd (Claude Desktop), pin a project:

```jsonc
"vectors": {
  "command": "bun",
  "args": ["/abs/path/src/mcp/server.ts"],
  "env": { "VINDEX_PROJECT": "scene" }   // omit to rely on search_global
}
```

Tools: `search`, `search_global`, `current_project`, `list_projects`,
`project_status`, `ingest`, `reindex`, `create_project`, `add_source`,
`validate_citations`, `resolve_reference`, `recall_intents`, `resolve_intent`.

## Config & internals

`VINDEX_DSN` (alias `UKDB_DSN`) is the Postgres DSN; the config/cache home is
`$VINDEX_HOME` (default `~/.local/share/vector-index`) — vectors live in
Postgres. Models via `$VINDEX_EMBED_MODEL` / `$VINDEX_RERANK_MODEL`; pin the
active project with `$VINDEX_PROJECT`.

- [`SKILL.md`](SKILL.md) — full skill guide (workflow, AST ingestion, hybrid
  search, intent memory, daemon, MCP).
- [`references/architecture.md`](references/architecture.md) — internals,
  project resolution, schema, extension points.
- [`../../spec.md`](../../spec.md) — the exhaustive system specification.

## Layout

```
SKILL.md                    skill entrypoint
README.md
assets/viewer/              3D synapse navigator front-end (index.html, viewer.css, js/)
daemon/                     background daemon service tooling (install.sh, env, plist)
references/
  architecture.md           internals & extension points
  unified-knowledge-db.sql  full DDL
  unified-knowledge-db-spec.md
  generalized-capabilities.md
```

The engine itself lives at the repo root under `src/` (TypeScript on Bun); this
skill directory ships the docs, the daemon service tooling, and a mirror of the
viewer front-end bundle (kept in sync with `assets/viewer/` by
`scripts/sync-assets.ts`).
