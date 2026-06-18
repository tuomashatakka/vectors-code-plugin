#!/usr/bin/env python3
"""
guards — capability & environment guards (C9).

Generalized from the codebase-RAG document, which gated its whole index/MCP
surface behind an environment check at three layers (route, server, client). The
plugin is read-mostly, but `ingest` / `reindex` / `create_project` / `add_source`
mutate state and read arbitrary filesystem paths, so they declare an enablement
guard enforced *before any logic runs*:

    VINDEX_READONLY=1            block all mutating operations
    VINDEX_ALLOW_ROOTS=a:b:c     only ingest/create from under these roots

Stdlib only; reads the environment live so a host can flip the policy per process.
Guards return an error dict (so MCP tools surface it) or None to proceed.
"""

from __future__ import annotations

import os
from pathlib import Path

_TRUE = {"1", "true", "yes", "on"}


def readonly() -> bool:
    return os.environ.get("VINDEX_READONLY", "").strip().lower() in _TRUE


def deny_if_readonly(tool: str) -> dict | None:
    if readonly():
        return {"error": f"{tool} blocked: VINDEX_READONLY is set (read-only mode)"}
    return None


def allowed_roots() -> list[Path]:
    raw = os.environ.get("VINDEX_ALLOW_ROOTS", "")
    out: list[Path] = []
    for part in raw.split(os.pathsep):
        part = part.strip()
        if part:
            try:
                out.append(Path(os.path.expanduser(part)).resolve())
            except Exception:
                pass
    return out


def path_allowed(path: str | os.PathLike) -> bool:
    roots = allowed_roots()
    if not roots:
        return True  # no allow-list configured -> unrestricted
    try:
        p = Path(os.path.expanduser(str(path))).resolve()
    except Exception:
        return False
    return any(p == r or r in p.parents for r in roots)


def deny_if_path_blocked(tool: str, path: str | os.PathLike | None) -> dict | None:
    if path and not path_allowed(path):
        return {"error": f"{tool} blocked: {path} is outside VINDEX_ALLOW_ROOTS"}
    return None
