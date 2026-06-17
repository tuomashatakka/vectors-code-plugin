#!/usr/bin/env python3
"""
vindex — CLI for the global, project-partitioned local semantic RAG store.

The active project is auto-resolved from your working directory, so the project
argument is optional on most commands (omit it to use the resolved project).

    # index the project you're standing in (root defaults to the --source dir)
    vindex create scene --source . --strategy code --glob '**/*.ts' --glob '**/*.md'
    vindex ingest                       # project resolved from cwd
    vindex query "how does the flock pick ideas?"

    # a git repo with reconstructed public urls
    vindex create rustbook --git https://github.com/rust-lang/book \
        --glob '**/*.md' --base-url 'https://doc.rust-lang.org/book/{path}.html'
    vindex ingest rustbook

    # ask across EVERY project at once (the global context)
    vindex search "welded indexed geometry deterministic seed"

    vindex projects        # all projects (* = the one this cwd resolves to)
    vindex here            # which project does this directory resolve to?
    vindex status --all
    vindex reindex scene
    vindex serve  scene    # 3D viewer -> http://localhost:7341
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vector_index as vi  # noqa: E402

sys.stdout.reconfigure(line_buffering=True)


def _print(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def _resolve_name(project):
    """Project arg if given, else the one resolved from the cwd."""
    return project or vi.resolve_project_name()


def _fmt_results(res: dict):
    scope = res.get("scope", "project")
    print(f'"{res["query"]}"  ({"reranked" if res.get("reranked") else "vector-only"}, {scope})')
    if scope == "global":
        print(f"  searched: {', '.join(res.get('projects', [])) or '(none)'}")
    if not res["results"]:
        print("  (no results)")
        return
    for i, r in enumerate(res["results"], 1):
        score = r.get("rerank_score", r.get("vector_score"))
        proj = r.get("project", "")
        loc = r.get("url") or r.get("source", "")
        print(f"  {i}. [{proj}] {r['title']}  ({score})")
        print(f"     {loc}")
        print(f"     {r['snippet']}")


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def _make_source(a):
    sid = getattr(a, "id", None) or (
        Path(a.source).name if a.source else a.git.rstrip("/").split("/")[-1]
    )
    return vi.Source(
        id=sid,
        type="git" if a.git else "dir",
        path=a.source or None,
        repo=a.git or None,
        ref=a.ref,
        subdir=a.subdir or "",
        globs=a.glob or vi.Source(id="x").globs,
        base_url=a.base_url,
        strip_ext=not a.keep_ext,
        lower_url=a.lower_url,
    )


def cmd_create(a):
    chunk = vi.ChunkConfig(strategy=a.strategy, max_chars=a.max_chars, overlap=a.overlap)
    kw = dict(chunk=chunk)
    if a.embed_model:
        kw["embed_model"] = a.embed_model
    if a.rerank_model:
        kw["rerank_model"] = a.rerank_model
    # root defaults to the local source dir so cwd-resolution works out of the box
    root = a.root or (a.source if (a.source and not a.git) else None)
    if root:
        kw["root"] = root
    proj = vi.Project.create(a.project, **kw)
    if a.source or a.git:
        proj.add_source(_make_source(a))
    print(f"created project {a.project!r} (dim={proj.index.cfg.embed_dim}, "
          f"root={proj.root}) at {vi.index_dir(a.project)}")
    if a.source or a.git:
        print(f"  added source; run:  vindex ingest {a.project}")


def cmd_add_source(a):
    proj = vi.Project.load(_resolve_name(a.project))
    proj.add_source(_make_source(a))
    print(f"source added to {proj.name!r}: {a.git or a.source}")


def cmd_ingest(a):
    name = _resolve_name(a.project)
    print(f"ingesting project: {name}", flush=True)
    _print(vi.Project.load(name).ingest(rebuild=a.rebuild))


def cmd_query(a):
    if a.all_projects or a.projects:
        subset = a.projects.split(",") if a.projects else None
        res = vi.global_search(a.query, topk=a.topk, rerank=not a.no_rerank, projects=subset)
    else:
        res = vi.Project.load(_resolve_name(a.project)).search(
            a.query, topk=a.topk, rerank=not a.no_rerank
        )
    if a.json:
        for r in res["results"]:
            r.pop("_vec", None)
        _print(res)
    else:
        _fmt_results(res)


def cmd_search(a):
    subset = a.projects.split(",") if a.projects else None
    res = vi.global_search(a.query, topk=a.topk, rerank=not a.no_rerank, projects=subset)
    if a.json:
        _print(res)
    else:
        _fmt_results(res)


def cmd_status(a):
    if a.all:
        _print(vi.project_records())
        return
    _print(vi.Project.load(_resolve_name(a.project)).status())


def cmd_projects(a):
    active = vi.resolve_project_name()
    records = vi.project_records()
    if a.json:
        for r in records:
            r["active"] = r.get("project") == active
        _print(records)
        return
    if not records:
        print("(no projects yet — create one with `vindex create <name> --source <dir>`)")
        return
    for r in records:
        mark = "*" if r.get("project") == active else " "
        root = r.get("root") or "-"
        print(f" {mark} {str(r.get('project')):<20} {str(r.get('state','?')):<7} "
              f"{str(r.get('doc_count','?')):>7} docs   {root}")


def cmd_here(a):
    name = vi.resolve_project_name()
    exists = vi.config_path(name).exists()
    print(f"cwd:     {os.getcwd()}")
    print(f"project: {name}  ({'configured' if exists else 'not created yet'})")
    if os.environ.get("VINDEX_PROJECT"):
        print(f"  (pinned via $VINDEX_PROJECT={os.environ['VINDEX_PROJECT']})")


def cmd_list(a):
    for n in vi.list_projects():
        print(n)


def cmd_reindex(a):
    name = _resolve_name(a.project)
    print(f"reindexing project: {name}", flush=True)
    _print(vi.Project.load(name).ingest(rebuild=True))


def cmd_serve(a):
    os.environ.setdefault("VINDEX_DEFAULT", _resolve_name(a.project))
    if a.port:
        os.environ["PORT"] = str(a.port)
    import viewer_server  # noqa: E402

    viewer_server.main(index_name=_resolve_name(a.project))


# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
def _source_flags(sp):
    sp.add_argument("--source", help="local directory to index")
    sp.add_argument("--git", help="git repo URL to clone + index")
    sp.add_argument("--ref", default="HEAD", help="git branch/tag (default HEAD)")
    sp.add_argument("--subdir", default="", help="only index this subdir of the source")
    sp.add_argument("--glob", action="append", help="glob (repeatable), e.g. '**/*.md'")
    sp.add_argument("--base-url", help="public URL template, {path} = file path")
    sp.add_argument("--keep-ext", action="store_true", help="keep file extension in URL")
    sp.add_argument("--lower-url", action="store_true", help="lowercase the URL path")


def build_parser():
    p = argparse.ArgumentParser(prog="vindex", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="create a project")
    c.add_argument("project")
    c.add_argument("--root", help="filesystem root for cwd auto-resolution "
                                  "(defaults to --source for a local dir)")
    c.add_argument("--strategy", default="auto", choices=["auto", "markdown", "code", "text"])
    c.add_argument("--max-chars", type=int, default=1500)
    c.add_argument("--overlap", type=int, default=150)
    c.add_argument("--embed-model")
    c.add_argument("--rerank-model")
    _source_flags(c)
    c.set_defaults(fn=cmd_create)

    s = sub.add_parser("add-source", help="add a source to a project")
    s.add_argument("project", nargs="?", help="project (default: resolved from cwd)")
    s.add_argument("--id", help="source id (default: derived from path/url)")
    _source_flags(s)
    s.set_defaults(fn=cmd_add_source)

    g = sub.add_parser("ingest", help="(re)ingest a project's sources")
    g.add_argument("project", nargs="?", help="project (default: resolved from cwd)")
    g.add_argument("--rebuild", action="store_true", help="wipe before ingesting")
    g.set_defaults(fn=cmd_ingest)

    # query: 1 positional => query (project from cwd); 2 => project + query.
    q = sub.add_parser("query", help="search ONE project (project optional)")
    q.add_argument("project", nargs="?")
    q.add_argument("query")
    q.add_argument("--topk", type=int, default=8)
    q.add_argument("--no-rerank", action="store_true")
    q.add_argument("--json", action="store_true")
    q.add_argument("-A", "--all-projects", action="store_true",
                   help="search across all projects (global)")
    q.add_argument("--projects", help="comma-separated subset for global search")
    q.set_defaults(fn=cmd_query)

    sr = sub.add_parser("search", help="GLOBAL search across every project")
    sr.add_argument("query")
    sr.add_argument("--topk", type=int, default=8)
    sr.add_argument("--no-rerank", action="store_true")
    sr.add_argument("--projects", help="comma-separated subset of projects")
    sr.add_argument("--json", action="store_true")
    sr.set_defaults(fn=cmd_search)

    st = sub.add_parser("status", help="project status")
    st.add_argument("project", nargs="?", help="project (default: resolved from cwd)")
    st.add_argument("--all", action="store_true", help="status of every project")
    st.set_defaults(fn=cmd_status)

    pj = sub.add_parser("projects", help="list projects (* = active)")
    pj.add_argument("--json", action="store_true")
    pj.set_defaults(fn=cmd_projects)

    h = sub.add_parser("here", help="show which project this cwd resolves to")
    h.set_defaults(fn=cmd_here)

    li = sub.add_parser("list", help="list project names (plain)")
    li.set_defaults(fn=cmd_list)

    r = sub.add_parser("reindex", help="wipe + rebuild a project")
    r.add_argument("project", nargs="?", help="project (default: resolved from cwd)")
    r.set_defaults(fn=cmd_reindex)

    v = sub.add_parser("serve", help="run the 3D viewer for a project")
    v.add_argument("project", nargs="?", help="project (default: resolved from cwd)")
    v.add_argument("--port", type=int, default=0)
    v.set_defaults(fn=cmd_serve)

    return p


def main():
    args = build_parser().parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
