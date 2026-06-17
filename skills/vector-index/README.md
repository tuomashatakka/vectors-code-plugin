# vector-index

A global, local, in-process **semantic RAG store, partitioned by project**. One
store on disk; every project is its own embedded + cross-encoder-reranked index,
and the active project is **auto-resolved from your working directory**. Search a
single project or go **global** across every project at once. All local: no API
keys, no network at query time.

```
$VINDEX_HOME            one global RAG database
  ├── scene/            a project (own collection + config + root)
  ├── portfolio/        another project
  └── rustbook/         …
```

## Quick start

```bash
bash setup.sh                                  # .venv + deps
PY=./.venv/bin/python

# index the project you're standing in (root defaults to the source dir)
cd ~/Documents/Projects/scene
$PY /abs/scripts/vindex.py create scene --source . --strategy code \
    --glob '**/*.ts' --glob '**/*.md'
$PY /abs/scripts/vindex.py ingest              # project resolved from cwd
$PY /abs/scripts/vindex.py query "how does the flock pick ideas?"

# ask across every project
$PY scripts/vindex.py search "welded indexed geometry deterministic seed"

$PY scripts/vindex.py projects                 # all projects (* = active)
$PY scripts/vindex.py serve scene              # 3D viewer at http://localhost:7341
```

## Interfaces

| Use | Entry |
| --- | --- |
| Create / ingest / query / global search / serve | `scripts/vindex.py` (CLI) |
| Live project-aware tools for Claude / an agent | `scripts/mcp_server.py` (MCP) |
| Build retrieval into code | `import vector_index` (`Project`, `global_search`) |
| Explore one project's space | `vindex serve` → 3D viewer |

## MCP

```bash
VINDEX_PROJECT=scene claude mcp add scene-rag -- \
  "$PWD/.venv/bin/python" "$PWD/scripts/mcp_server.py"
```

Tools: `search`, `search_global`, `current_project`, `list_projects`,
`project_status`, `ingest`, `reindex`, `create_project`, `add_source`.

## Config & internals

The global store lives under `$VINDEX_HOME` (default
`~/.local/share/vector-index/`), one subdir per project. Models via
`$VINDEX_EMBED_MODEL` / `$VINDEX_RERANK_MODEL`; pin the active project with
`$VINDEX_PROJECT`. See [`references/architecture.md`](references/architecture.md)
for the project-resolution logic, the config + record schemas, how global search
merges and reranks, and how to swap models or the store.

## Layout

```
SKILL.md                    skill entrypoint
README.md
requirements.txt            zvec, sentence-transformers, numpy, mcp
setup.sh
scripts/
  vector_index.py           core library (Index + Project + global_search)
  vindex.py                 CLI
  mcp_server.py             FastMCP server (project-aware tools)
  viewer_server.py          JSON API + viewer host
assets/viewer.html          3D synapse navigator
references/architecture.md  internals & extension points
```
