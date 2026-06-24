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
export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors
bun install
vectors setup                                  # apply schema + default embedding space

# index the project you're standing in (root defaults to the cwd)
cd ~/Documents/Projects/scene
vectors project create scene --root .
vectors project add-source scene --id code --path . --glob '**/*.ts' --glob '**/*.md'
vectors project ingest scene                   # project resolved from cwd
vectors query "how does the flock pick ideas?"

# ask across every project
vectors search "welded indexed geometry deterministic seed"

vectors projects                               # all projects (* = active)
vectors serve scene                            # 3D viewer at http://localhost:7341
```

## Interfaces

| Use | Entry |
| --- | --- |
| Create / ingest / query / global search / serve / daemon | `vectors` CLI (alias `vindex`) |
| Query-first interactive shell | `vectors repl` |
| Live project-aware tools for Claude / an agent | `vectors mcp` (stdio MCP, 13 tools) |
| Explore one project's space | `vectors serve` → 3D viewer |

## MCP

```bash
vectors mcp     # run the stdio server; `bash ../../install.sh` wires it into editors
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
assets/viewer.html          3D synapse navigator
daemon/                     background daemon service tooling (install.sh, env, plist)
references/
  architecture.md           internals & extension points
  unified-knowledge-db.sql  full DDL
  unified-knowledge-db-spec.md
  generalized-capabilities.md
```

The engine itself lives at the repo root under `src/` (TypeScript on Bun); this
skill directory ships the docs, the daemon service tooling, and the viewer asset.
