#!/usr/bin/env python3
"""
orchestration — layered ("Bridge"-pattern) retrieval weighting.

Generalized from the legal-RAG multi-tenant design (C4): retrieval is modeled as
layers — a shared/global knowledge layer plus one or more project-scoped layers —
queried together and fused, with the balance shifted by what the query is asking.
"What do WE do about X" should lean on the scoped layer; "what does the standard
say about X" should lean on the shared layer.

Our project == a scoped layer; global search == the pool of all of them. This
module supplies the query-intent classifier and the per-layer weights that
`vector_index.global_search` feeds into Reciprocal Rank Fusion. Stdlib only.
"""

from __future__ import annotations

import re

# "Ours / here / internal" → favor the scoped (project) layer.
_SCOPED_HINTS = re.compile(
    r"\b(our|ours|my|mine|we|us|internal|this (?:project|repo|repository|codebase|file))\b",
    re.IGNORECASE,
)
# "Standard / spec / law / docs / convention" → favor the shared layer.
_SHARED_HINTS = re.compile(
    r"\b(standard|spec|specification|law|statute|regulation|reference|"
    r"documentation|docs|general|convention|best practice|guideline|rfc)\b",
    re.IGNORECASE,
)

_WEIGHTS = {
    "scoped": (0.8, 0.2),   # (scoped_layer_weight, shared_layer_weight)
    "shared": (0.2, 0.8),
    "balanced": (0.5, 0.5),
}


def classify_query_intent(query: str) -> str:
    """Return 'scoped' | 'shared' | 'balanced' from lexical hints in the query."""
    scoped = bool(_SCOPED_HINTS.search(query or ""))
    shared = bool(_SHARED_HINTS.search(query or ""))
    if scoped and not shared:
        return "scoped"
    if shared and not scoped:
        return "shared"
    return "balanced"


def layer_weights(intent: str) -> tuple[float, float]:
    """(scoped_weight, shared_weight) for the given intent."""
    return _WEIGHTS.get(intent, _WEIGHTS["balanced"])


def project_weights(
    project_names: list[str],
    shared: list[str] | None,
    intent: str,
) -> dict[str, float]:
    """Map each project to its fusion weight given which projects are the shared
    layer and the query intent. With no shared layer declared, every project is
    weighted equally (the current Pool behavior — fully backward compatible)."""
    shared_set = set(shared or [])
    if not shared_set:
        return {name: 1.0 for name in project_names}
    scoped_w, shared_w = layer_weights(intent)
    return {
        name: (shared_w if name in shared_set else scoped_w)
        for name in project_names
    }


def layer_of(name: str, shared: list[str] | None) -> str:
    return "shared" if name in set(shared or []) else "scoped"
