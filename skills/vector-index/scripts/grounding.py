#!/usr/bin/env python3
"""
grounding — provenance, confidence tiers, and lexical claim verification.

The trust layer generalized from the legal-RAG document (C5/C6): retrieval tools
still let downstream models hallucinate, and self-rated confidence is unreliable
(AUROC ~0.58). So instead we derive confidence from *retrieval strength and signal
agreement*, expose it as a categorical tier (lawyers and engineers both reason
about tiers, not opaque numbers), and offer a verifier that checks whether a
generated claim is actually supported by the spans it cites — flagging the rest.

Stdlib only; the default verifier is lexical, so it needs no model. An embedding
verifier can be layered on later by passing an encoder.
"""

from __future__ import annotations

from hybrid import tokenize

# Tuned for the default cross-encoder (ms-marco-MiniLM logits, ~ -11..+11) when
# reranked, and cosine similarity (0..1) when not. Constants, not magic numbers.
_RERANK_HIGH, _RERANK_MED = 4.0, 0.0
_COSINE_HIGH, _COSINE_MED = 0.55, 0.40


def confidence_tier(results: list[dict], reranked: bool = True) -> str:
    """A High/Medium/Low tier from the top result's score plus signal agreement.

    "Agreement" = a top hit found by BOTH the dense and lexical legs is stronger
    evidence than one leg alone, so it promotes the tier.
    """
    if not results:
        return "low"
    top = results[0].get("rerank_score")
    if top is None:
        top = results[0].get("vector_score")
    top = top if top is not None else 0.0
    agree = any(len(r.get("signals", [])) >= 2 for r in results[:3])
    hi, med = (_RERANK_HIGH, _RERANK_MED) if reranked else (_COSINE_HIGH, _COSINE_MED)
    if top >= hi or (top >= med and agree):
        return "high"
    if top >= med or agree:
        return "medium"
    return "low"


def verify_claim(claim: str, sources: list[str], threshold: float = 0.30) -> dict:
    """Is `claim` grounded in any of `sources`? Lexical recall of claim terms.

    score = |claim_terms ∩ source_terms| / |claim_terms| for the best source.
    Returns {supported, score, source_index}. Cheap, model-free, and language-
    agnostic — a first-pass groundedness gate before any expensive check.
    """
    cterms = set(tokenize(claim))
    if not cterms:
        return {"supported": False, "score": 0.0, "source_index": -1}
    best_score, best_idx = 0.0, -1
    for i, src in enumerate(sources):
        overlap = len(cterms & set(tokenize(src))) / len(cterms)
        if overlap > best_score:
            best_score, best_idx = overlap, i
    return {
        "supported": best_score >= threshold,
        "score": round(best_score, 3),
        "source_index": best_idx if best_score >= threshold else -1,
    }


def signal_summary(results: list[dict]) -> dict:
    """Count how the top results were found — provenance at the result-set level."""
    dense = sum(1 for r in results if "dense" in r.get("signals", []))
    lexical = sum(1 for r in results if "lexical" in r.get("signals", []))
    both = sum(1 for r in results if len(r.get("signals", [])) >= 2)
    return {"dense": dense, "lexical": lexical, "both": both, "total": len(results)}
