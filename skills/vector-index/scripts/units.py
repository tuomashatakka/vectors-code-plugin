#!/usr/bin/env python3
"""
units — typed semantic units (C1).

Generalized from the codebase-RAG document, which indexed `functions`, `types`,
and `dependencies` as first-class rows beside raw chunks, and the legal document,
whose unit was a statute section. Stripped of domain, a chunk has a *kind*:

    section     a headed block of prose/docs
    symbol      code that defines a callable (function/class/...)
    definition  code that defines a type/interface/enum/constant
    code        other source
    text        plain prose

Tagging each chunk with a `unit_type` (and, for code, its symbol name) lets search
filter by kind — "find the *definition* of X", "only *sections*". Stdlib only;
heuristic and language-agnostic, deliberately conservative (unknown → "text"/
"code"). The tag is computed at ingest and stored in the BM25 sidecar, so it needs
no change to the dense store and stays backward compatible.
"""

from __future__ import annotations

import re
from pathlib import Path

_MARKDOWN_EXT = {".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"}
_CODE_EXT = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".lua",
    ".sh", ".css", ".scss", ".sql", ".html", ".vue", ".svelte",
}

# A definition-ish line: optional modifiers, a defining keyword, optional name.
_DEF_RE = re.compile(
    r"^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|pub\s+)*"
    r"(?P<kw>def|function|func|fn|class|interface|type|enum|struct|trait|impl|const|let|var)\b"
    r"\s*(?P<name>[A-Za-z_$][\w$]*)?",
    re.MULTILINE,
)
_SYMBOL_KW = {"def", "function", "func", "fn", "class", "struct", "impl", "trait"}
_DEFINITION_KW = {"interface", "type", "enum", "const", "let", "var"}

KINDS = ("section", "symbol", "definition", "code", "text")


def _strategy_for(rel: str, strategy: str) -> str:
    if strategy != "auto":
        return strategy
    ext = Path(rel).suffix.lower()
    if ext in _MARKDOWN_EXT:
        return "markdown"
    if ext in _CODE_EXT:
        return "code"
    return "text"


def classify_unit(rel: str, text: str, strategy: str = "auto") -> str:
    """Return the unit_type for a chunk. Conservative: unknown → text/code."""
    strat = _strategy_for(rel, strategy)
    if strat == "markdown":
        return "section" if re.search(r"^#{1,6}\s", text or "", re.MULTILINE) else "text"
    if strat == "code":
        m = _DEF_RE.search(text or "")
        if m:
            return "symbol" if m.group("kw") in _SYMBOL_KW else "definition"
        return "code"
    return "text"


def symbol_name(text: str) -> str | None:
    """The first defined symbol/type name in a code chunk, if any."""
    m = _DEF_RE.search(text or "")
    return m.group("name") if (m and m.group("name")) else None
