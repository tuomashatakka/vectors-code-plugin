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

A **global RAG store, indexed by project**. One store on disk holds many
projects; each project is an isolated semantic index, but they share a roof and
can be searched together. Point it at a corpus, get reranked semantic search
back — per project or across all of them — plus an MCP server and a 3D embedding
viewer.

This is the project-partitioned evolution of the corpus-agnostic engine
(originally extracted from `semantic-html`): same proven zvec +
sentence-transformers + cross-encoder pipeline, now with **project** as the
first-class key and a **global context** that spans every project.

```
$VINDEX_HOME            one global RAG database (a directory)
  ├── scene/            a project: its own zvec collection + config + root
  ├── portfolio/        another project
  └── rustbook/         …

per-project:  files -> chunk -> embed -> zvec store   (ingest, once)
              query -> embed -> top-k -> rerank       (search, fast, offline)
global:       fan out across every project -> merge -> one rerank -> tagged hits
```

## The core idea: project is auto-resolved from the working directory

The point of "indexed by project" is that you rarely name the project. When you
(or an agent) are working inside `~/Documents/Projects/scene`, the tools resolve
the `scene` project for you. Resolution order:

1. `$VINDEX_PROJECT` — an explicit per-process pin (wins over everything).
2. The project whose configured `root` is the nearest ancestor of the cwd.
3. Walking up for a `.git` / `.vindex` marker; the name is the marker dir's
   basename (or the first line of a `.vindex` file if present).
4. `$VINDEX_DEFAULT` (default `"default"`).

So a per-repo MCP server (Claude Code, opencode) "just works" on the right
project. A server with no stable cwd (Claude Desktop) should pin one with
`$VINDEX_PROJECT`, or lean on **global search**, which doesn't care where you are.

## When to use which interface

- **CLI** (`scripts/vindex.py`) — create projects, ingest, one-off queries
  (project or global), list projects, serve the viewer.
- **MCP server** (`scripts/mcp_server.py`) — give Claude / an agent live
  `search` (auto-project), `search_global`, `current_project`, `list_projects`,
  `project_status`, `ingest`, `reindex`, `create_project`, `add_source`.
- **Library** (`scripts/vector_index.py`) — `import vector_index`; use the
  `Project` class plus `global_search` / `project_records` / `resolve_project_name`.
- **3D viewer** (`vindex serve`) — explore one project's embedding space.

## Setup (once)

```bash
bash setup.sh                       # creates .venv, installs deps
# deps: zvec, sentence-transformers, numpy, mcp
```

The global store lives under `$VINDEX_HOME` (default
`~/.local/share/vector-index/`), with one subdirectory per project, each holding
its own `config.json`, zvec store, and any cloned git sources. Override models
with `$VINDEX_EMBED_MODEL` / `$VINDEX_RERANK_MODEL`.

## Core workflow

Always **create a project → add sources → ingest → query**. Pick the chunking
strategy to match the corpus (`markdown` for docs, `code` for source trees,
`text` for prose; `auto` decides per file extension). A project over a local
directory is rooted there by default, so auto-resolution works immediately.

```bash
PY=./.venv/bin/python

# 1. index the project you're standing in (root defaults to --source dir)
cd ~/Documents/Projects/scene
$PY .../scripts/vindex.py create scene --source . --strategy code \
    --glob '**/*.ts' --glob '**/*.md'
$PY .../scripts/vindex.py ingest                  # project resolved from cwd
$PY .../scripts/vindex.py query "how does the flock pick ideas?"

# 2. a folder of notes
$PY scripts/vindex.py create notes --source ~/Documents/notes --strategy markdown
$PY scripts/vindex.py ingest notes

# 3. a git repo, with public URLs reconstructed for each hit
$PY scripts/vindex.py create rustbook \
    --git https://github.com/rust-lang/book --glob '**/*.md' \
    --base-url 'https://doc.rust-lang.org/book/{path}.html'
$PY scripts/vindex.py ingest rustbook

# ask across EVERY project at once (the global context)
$PY scripts/vindex.py search "welded indexed geometry deterministic seed"

# housekeeping
$PY scripts/vindex.py projects        # all projects + doc counts + roots (* = active)
$PY scripts/vindex.py here            # which project does this dir resolve to?
$PY scripts/vindex.py status --all    # status of every project
$PY scripts/vindex.py reindex scene   # wipe + rebuild
$PY scripts/vindex.py serve  scene    # 3D viewer -> http://localhost:7341
```

Add `--no-rerank` for raw vector order (faster, skips the cross-encoder).
Add `--json` for machine-readable output. On `query`, add `-A/--all-projects`
(or `--projects a,b`) to go global without switching to the `search` command.

## MCP server

```bash
# Claude Code — pin the project for a per-repo server
VINDEX_PROJECT=scene claude mcp add scene-rag -- \
  "$PWD/.venv/bin/python" "$PWD/scripts/mcp_server.py"
```

```jsonc
// Claude Desktop / opencode — mcpServers entry (no stable cwd → pin or go global)
"vectors": {
  "command": "/abs/path/.venv/bin/python",
  "args": ["/abs/path/scripts/mcp_server.py"],
  "env": { "VINDEX_PROJECT": "scene" }   // omit to rely on search_global
}
```

Tools: `search(query, project?, topk?, rerank?, hybrid?, kinds?, max_tokens?)`,
`search_global(query, topk?, rerank?, projects?, hybrid?, shared?, kinds?,
max_tokens?)`, `validate_citations(text, project?)`,
`resolve_reference(uri, network?)`, `current_project()`, `list_projects()`,
`project_status(project?)`, `ingest(project?)`, `reindex(project?)`,
`create_project(...)`, `add_source(...)`. Search is **hybrid** (dense + BM25,
RRF-fused, cross-encoder reranked): each hit is tagged with the `signals` that
found it and a `unit_type`, and the result set carries a `confidence` tier;
`kinds` filters by unit type, `max_tokens` trims to a token budget, and
`search_global(shared=[…])` adds Bridge-pattern layer weighting. Mutating tools
honor `VINDEX_READONLY` / `VINDEX_ALLOW_ROOTS`; grounding/reasoning **prompt
scaffolds** (`grounded_answer`, `decompose`, `citation_contract`) are exposed as
MCP Prompts. The server auto-populates the resolved default project on startup if
it's empty but has sources.

## Library

```python
import vector_index as vi

# create + ingest a project rooted at a directory
p = vi.Project.create("scene", root="~/Documents/Projects/scene",
                      source="~/Documents/Projects/scene", strategy="code")
# (or attach sources explicitly with p.add_source(vi.Source(...)))
p.ingest()

# search the project that owns the current directory
vi.Project.resolve().search("how does the flock loop pick ideas?")

# search across every project, hits tagged with their project
vi.global_search("welded indexed geometry", topk=8)

vi.project_records()            # [{project, root, state, doc_count, sources}, ...]
vi.resolve_project_name()       # the project name the cwd resolves to
```

## Choosing sources & URLs

A source is a `dir` or a `git` repo, filtered by `--glob` (repeatable) and
`--base-url` (a template where `{path}` is the file path relative to the source
root; `--keep-ext` / `--lower-url` adjust the transform). See
`references/architecture.md` for the config schema, the zvec record shape,
chunking internals, the project-resolution logic, how global search merges +
reranks, and how to add a chunking strategy or swap the embedding model/store.

## Notes carried over from the engine

- zvec has no `commit()`; persistence is `flush()` then `optimize()` (done for
  you in `ingest`).
- `collection.stats` is a **property**; doc count is `stats.doc_count`.
- Chunk **text is stored in the index** (`text` field), so search never
  reconstructs from disk.
- Everything is local: embedding (`all-MiniLM-L6-v2`) and rerank
  (`cross-encoder/ms-marco-MiniLM-L6-v2`) models run on-device; models cache
  under `~/.cache/huggingface`, not in the store.
- Global search reranks the union of per-project candidates with the
  cross-encoder, so ordering is comparable across projects even when they use
  different embedding models. Without rerank, cross-model vector scores are not
  comparable — so rerank is the default for global queries.

## Bundled files

- `scripts/vector_index.py` — core library (config, chunking, store, `Index`,
  `Project`, resolution, `global_search`).
- `scripts/hybrid.py` — BM25 lexical index + RRF fusion + context-prefix (the
  sparse half of hybrid search).
- `scripts/grounding.py` — confidence tiers + claim verification.
- `scripts/orchestration.py` — Bridge-pattern layer weighting for global search.
- `scripts/references.py` — reference extraction + citation validation.
- `scripts/units.py` — typed semantic units (`unit_type` + `kinds` filter).
- `scripts/assemble.py` — token-budget context assembly (`max_tokens`).
- `scripts/guards.py` — capability guards (`VINDEX_READONLY` / `VINDEX_ALLOW_ROOTS`).
- `scripts/prompts.py` — grounding/reasoning prompt scaffolds.
- `scripts/vindex.py` — CLI.
- `scripts/mcp_server.py` — FastMCP stdio server (project-aware tools).
- `scripts/viewer_server.py` — JSON API + viewer host.
- `assets/viewer.html` — 3D synapse navigator.
- `references/architecture.md` — internals, schema, extension points.
- `references/unified-knowledge-db-spec.md` — design for a unified PostgreSQL +
  pgvector store (vectors + chat memory + external references + own content) with
  a 4-level memory abstraction, Ollama-driven background digesting, and
  token-saving retrieval; DDL in `references/unified-knowledge-db.sql`.
- `daemon/` — background daemon (`ukdb_daemon.py`) that keeps the unified DB
  current from chat transcripts + file sources and drains the digest queue, with
  macOS launchd / Linux systemd install tooling (`install.sh`); see
  `daemon/README.md`.
