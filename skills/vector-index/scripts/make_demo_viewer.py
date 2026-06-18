#!/usr/bin/env python3
"""
make_demo_viewer — generate docs/viewer-demo.html from the canonical viewer.

The public site embeds a live, server-free preview of the 3D synapse viewer. Rather
than fork the viewer, we take the single source of truth (assets/viewer.html) and
enable its built-in demo mode by injecting `window.VINDEX_DEMO=true`, so the page
renders a procedural embedding cloud with no backend and no data dependency.

Stdlib only; no index required. Run ad hoc or from the GitHub Pages build:

    python3 skills/vector-index/scripts/make_demo_viewer.py [out.html]
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve()
VIEWER = HERE.parents[1] / "assets" / "viewer.html"        # skills/vector-index/assets
DEFAULT_OUT = HERE.parents[3] / "docs" / "viewer-demo.html"  # repo-root/docs

_FLAG = "<script>window.VINDEX_DEMO=true;</script>"


def build(out: Path) -> Path:
    html = VIEWER.read_text(encoding="utf-8")
    if _FLAG not in html:
        html = html.replace("<body>", "<body>\n" + _FLAG, 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    written = build(out)
    print(f"wrote demo viewer -> {written}")
