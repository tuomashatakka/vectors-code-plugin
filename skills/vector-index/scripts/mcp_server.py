#!/usr/bin/env python3
"""
mcp_server.py — expose the global, project-partitioned RAG store over MCP (stdio).

One server serves the whole global store. Tools take an optional `project`; when
omitted, the server resolves it the same way the CLI does — $VINDEX_PROJECT, then
the project whose root is an ancestor of the server's working directory, then a
.git/.vindex marker, then $VINDEX_DEFAULT. This means a per-repo server (Claude
Code / opencode) just works on that project; a server with no stable cwd (Claude
Desktop) should pin one via $VINDEX_PROJECT or lean on `search_global`.

Register (Claude Code):
    VINDEX_PROJECT=scene claude mcp add scene-rag -- \
      /path/.venv/bin/python /path/scripts/mcp_server.py

Tools:
    search(query, project?, topk?, rerank?)          within one project
    search_global(query, topk?, rerank?, projects?)  across every project
    current_project()                                what resolves from cwd
    list_projects()                                  all projects + doc counts
    project_status(project?)                         state / models / sources
    ingest(project?)                                 (re)ingest from sources
    reindex(project?)                                wipe + rebuild
    create_project(name, root?, source?, git?, globs?, base_url?, strategy?)
    add_source(project?, source?, git?, globs?, base_url?)

On startup, if the resolved default project exists, is empty, and has sources,
the server kicks off a background ingest so the first query isn't cold.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vector_index as vi  # noqa: E402
import references as refs  # noqa: E402
import guards  # noqa: E402
import prompts as prompt_lib  # noqa: E402

from mcp.server.fastmcp import FastMCP  # noqa: E402

mcp = FastMCP("vector-index")


def _resolve(project: str) -> str:
    return project or vi.resolve_project_name()


def _kinds(kinds: str) -> list[str] | None:
    return [k.strip() for k in kinds.split(",") if k.strip()] or None


def _strip(res: dict) -> dict:
    for r in res.get("results", []):
        r.pop("_vec", None)
    return res


@mcp.tool()
def search(query: str, project: str = "", topk: int = 8, rerank: bool = True,
           hybrid: bool = True, kinds: str = "", max_tokens: int = 0) -> dict:
    """Hybrid semantic + keyword search within ONE project. `project` defaults to
    the one resolved from the working directory. Dense (embeddings) and sparse
    (BM25) results are fused with Reciprocal Rank Fusion, then cross-encoder
    reranked. Each hit is tagged with the signal(s) that found it (`dense`/
    `lexical`) and a `unit_type`; the result carries a `confidence` tier. `kinds`
    is a comma-separated unit_type filter (section/symbol/definition/code/text);
    `max_tokens` trims results to a token budget. Set `hybrid=false` for dense
    only."""
    name = _resolve(project)
    return _strip(vi.Project.load(name).search(
        query, topk=topk, rerank=rerank, hybrid=hybrid,
        kinds=_kinds(kinds), max_tokens=max_tokens))


@mcp.tool()
def search_global(query: str, topk: int = 8, rerank: bool = True, projects: str = "",
                  hybrid: bool = True, shared: str = "", kinds: str = "",
                  max_tokens: int = 0) -> dict:
    """Hybrid search across EVERY project (or a comma-separated subset via
    `projects`). Each hit is tagged with its project. Pass `shared` (comma-
    separated project names) to treat those as a shared knowledge layer: the query
    intent then weights the shared vs project-scoped layers (Bridge pattern), and
    hits are tagged with their `layer`. `kinds` filters by unit_type; `max_tokens`
    trims to a token budget. Use this when you don't know which project holds the
    answer."""
    subset = [p.strip() for p in projects.split(",") if p.strip()] or None
    shared_list = [p.strip() for p in shared.split(",") if p.strip()] or None
    return _strip(vi.global_search(query, topk=topk, rerank=rerank, projects=subset,
                                   hybrid=hybrid, shared=shared_list,
                                   kinds=_kinds(kinds), max_tokens=max_tokens))


@mcp.tool()
def validate_citations(text: str, project: str = "", topk: int = 5) -> dict:
    """Ground-check references in `text` against the indexed corpus. Extracts URLs
    and citation-shaped tokens, verifies each appears in retrieved chunks, and
    returns per-reference verdicts plus a copy of the text with unverifiable
    references flagged `[UNVERIFIED]`. Use to catch hallucinated citations before
    trusting generated output."""
    name = _resolve(project)
    proj = vi.Project.load(name)
    search_fn = lambda q, k: proj.search(q, topk=k, rerank=False)  # noqa: E731
    return refs.validate_citations(text, search_fn, topk=topk)


@mcp.tool()
def resolve_reference(uri: str, network: bool = False) -> dict:
    """Resolve/validate an external reference. With `network=true` performs a HEAD
    request to check a URL is reachable (off by default to honor the no-network-
    at-query-time guarantee)."""
    return refs.resolve_reference(uri, network=network)


@mcp.tool()
def current_project() -> dict:
    """The project that resolves from the server's working directory, plus its
    status. Use this to confirm scope before relying on the default `search`."""
    name = vi.resolve_project_name()
    if not vi.config_path(name).exists():
        return {"project": name, "exists": False, "cwd": os.getcwd()}
    st = vi.Project.load(name).status()
    st["exists"] = True
    st["cwd"] = os.getcwd()
    return st


@mcp.tool()
def list_projects() -> list[dict]:
    """Every project in the global store with root, state, and doc count."""
    return vi.project_records()


@mcp.tool()
def project_status(project: str = "") -> dict:
    """Status of one project: state, doc_count, models, configured sources."""
    return vi.Project.load(_resolve(project)).status()


@mcp.tool()
def ingest(project: str = "") -> dict:
    """(Re)ingest a project's configured sources into its index."""
    if err := guards.deny_if_readonly("ingest"):
        return err
    return vi.Project.load(_resolve(project)).ingest()


@mcp.tool()
def reindex(project: str = "") -> dict:
    """Wipe and rebuild a project's index from its configured sources."""
    if err := guards.deny_if_readonly("reindex"):
        return err
    return vi.Project.load(_resolve(project)).ingest(rebuild=True)


@mcp.tool()
def create_project(
    name: str,
    root: str = "",
    source: str = "",
    git: str = "",
    globs: str = "",
    base_url: str = "",
    strategy: str = "auto",
) -> dict:
    """Register a new project. `root` is the filesystem root used to auto-resolve
    it from a cwd (defaults to `source` for a local dir). Optionally attach a
    first source (`source` dir or `git` URL) with comma-separated `globs` and an
    optional `base_url` template (use {path}). Call `ingest` afterwards."""
    if err := guards.deny_if_readonly("create_project"):
        return err
    if err := guards.deny_if_path_blocked("create_project", source or root):
        return err
    if vi.config_path(name).exists():
        return {"error": f"project {name!r} already exists"}
    use_root = root or (source if source and not git else None)
    proj = vi.Project.create(
        name,
        root=use_root,
        chunk=vi.ChunkConfig(strategy=strategy),
    )
    if source or git:
        glob_list = [g.strip() for g in globs.split(",") if g.strip()]
        sid = (Path(source).name if source else git.rstrip("/").split("/")[-1])
        proj.add_source(vi.Source(
            id=sid,
            type="git" if git else "dir",
            path=source or None,
            repo=git or None,
            globs=glob_list or vi.Source(id="x").globs,
            base_url=base_url or None,
        ))
    return proj.status()


@mcp.tool()
def add_source(
    project: str = "",
    source: str = "",
    git: str = "",
    globs: str = "",
    base_url: str = "",
) -> dict:
    """Add a source (local `source` dir or `git` URL) to a project. `globs` is a
    comma-separated list; `base_url` is an optional {path} URL template."""
    if err := guards.deny_if_readonly("add_source"):
        return err
    if err := guards.deny_if_path_blocked("add_source", source):
        return err
    name = _resolve(project)
    proj = vi.Project.load(name)
    if not (source or git):
        return {"error": "provide a source dir or a git URL"}
    glob_list = [g.strip() for g in globs.split(",") if g.strip()]
    sid = (Path(source).name if source else git.rstrip("/").split("/")[-1])
    proj.add_source(vi.Source(
        id=sid,
        type="git" if git else "dir",
        path=source or None,
        repo=git or None,
        globs=glob_list or vi.Source(id="x").globs,
        base_url=base_url or None,
    ))
    return proj.status()


def _register_prompts() -> None:
    """Expose the grounding/reasoning scaffolds as MCP Prompts, if this FastMCP
    build supports them (registration is version-guarded so it never breaks
    startup)."""
    if not hasattr(mcp, "prompt"):
        return
    try:
        mcp.prompt()(prompt_lib.grounded_answer)
        mcp.prompt()(prompt_lib.decompose)
        mcp.prompt()(prompt_lib.citation_contract)
    except Exception as e:  # pragma: no cover - older/newer API surface
        print(f"[mcp_server] prompt registration skipped: {e}", file=sys.stderr)


_register_prompts()


if __name__ == "__main__":
    _default = vi.resolve_project_name()
    if vi.config_path(_default).exists():
        vi.ensure_populated_async(_default)
    mcp.run()
