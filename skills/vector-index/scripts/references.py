#!/usr/bin/env python3
"""
references — extract, validate, and ground external references / citations.

Generalized from the company-data MCP server and citation engine (C8): pull the
references out of a piece of text (URLs and citation-shaped tokens), and validate
each one — either against the indexed corpus (does this citation actually appear
in what we know?) or, optionally and off the hot path, against the live network.
Unverifiable references are flagged `[UNVERIFIED]`, the same defense the legal-RAG
document prescribes for hallucinated citations.

Stdlib only. The corpus check takes an injected `search_fn`, so it is decoupled
from the engine and unit-testable with a fake searcher; network resolution is
opt-in.
"""

from __future__ import annotations

import re
import urllib.request

_URL_RE = re.compile(r"https?://[^\s)<>\]\"']+")
# Generic citation shapes: "228/1929", "KPL 3:9.2", "RFC 7231", "ISO 8601",
# "Section 12", "[Law §]". Domain callers can pass extra patterns.
_CITATION_RES = [
    re.compile(r"\b[0-9]{1,5}/[0-9]{2,4}\b"),                  # number/year
    re.compile(r"\b[A-Z]{2,6}\s?\d+(?::\d+(?:\.\d+)*)?\b"),    # CODE 3:9.2 / RFC 7231
    re.compile(r"§\s?\d+[a-z]?"),                              # § 36
]
# Real URLs/citations are short. An over-long match is almost always a minified
# line or an embedded blob — and would overflow the unified-DB's btree
# UNIQUE(kind, uri) index (~2704-byte limit), killing the extract_references job.
_MAX_URI = 2048


def extract_references(text: str, patterns: list[re.Pattern] | None = None) -> list[dict]:
    """Return de-duplicated [{kind, uri}] for URLs and citation-shaped tokens."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def _add(kind: str, uri: str):
        if not uri or len(uri) > _MAX_URI:
            return
        key = (kind, uri)
        if key not in seen:
            seen.add(key)
            out.append({"kind": kind, "uri": uri})

    for u in _URL_RE.findall(text or ""):
        _add("url", u.rstrip(".,);"))
    for pat in (patterns or _CITATION_RES):
        for m in pat.findall(text or ""):
            _add("citation", m.strip())
    return out


def validate_citations(
    text: str,
    search_fn,
    *,
    threshold: float = 0.0,
    topk: int = 5,
    patterns: list[re.Pattern] | None = None,
) -> dict:
    """Check every reference in `text` against the corpus via `search_fn`.

    `search_fn(query, topk)` must return a result dict shaped like the engine's
    (a "results" list of {text, source, ...}). A reference is *verified* when it
    appears verbatim in a retrieved chunk, or a retrieved chunk clears `threshold`
    on rerank/vector score. Returns the per-reference verdicts plus an annotated
    copy of the text with unverifiable references marked `[UNVERIFIED]`.
    """
    refs = extract_references(text, patterns)
    annotated = text
    verdicts = []
    for ref in refs:
        uri = ref["uri"]
        res = search_fn(uri, topk) or {}
        results = res.get("results", [])
        verbatim = next((r for r in results if uri.lower() in (r.get("text", "").lower())), None)
        if verbatim is not None:
            ok, src = True, verbatim.get("source") or verbatim.get("url")
        elif results:
            top = results[0]
            score = top.get("rerank_score", top.get("vector_score") or 0.0)
            ok = score is not None and score >= threshold
            src = top.get("source") or top.get("url") if ok else None
        else:
            ok, src = False, None
        verdicts.append({"kind": ref["kind"], "uri": uri, "verified": ok, "source": src})
        if not ok:
            annotated = annotated.replace(uri, f"{uri} [UNVERIFIED]")
    n_ok = sum(1 for v in verdicts if v["verified"])
    return {
        "references": verdicts,
        "verified": n_ok,
        "unverified": len(verdicts) - n_ok,
        "annotated": annotated,
    }


def resolve_reference(uri: str, *, timeout: float = 8.0, network: bool = False) -> dict:
    """Optionally validate a URL is live (HEAD request). Off by default to honor
    the plugin's no-network-at-query-time guarantee; callers opt in explicitly."""
    if not network or not uri.lower().startswith(("http://", "https://")):
        return {"uri": uri, "checked": False, "reachable": None}
    req = urllib.request.Request(uri, method="HEAD", headers={"User-Agent": "vectors-plugin"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"uri": uri, "checked": True, "reachable": True, "status": resp.status}
    except Exception as e:  # network/HTTP error -> not reachable
        return {"uri": uri, "checked": True, "reachable": False, "error": str(e)[:200]}
