/**
 * grounding — provenance, confidence tiers, and lexical claim verification.
 *
 * Confidence is derived from retrieval strength + signal agreement (not from a
 * model's unreliable self-rating) and exposed as a categorical tier. The verifier
 * checks whether a claim is lexically supported by its cited spans. Model-free.
 * Ported from grounding.py.
 */
import type { ConfidenceTier, SearchHit } from '../db/types.ts'

// Tuned for the default cross-encoder (ms-marco logits ~ -11..+11) when reranked,
// and cosine similarity (0..1) when not.
const RERANK_HIGH = 4.0
const RERANK_MED  = 0.0
const COSINE_HIGH = 0.55
const COSINE_MED  = 0.4

const TOKEN_RE = /[0-9]+(?:[/:.\-][0-9]+)+|\w+/gu

export function tokenize (text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? []
}

/** Loose result shape matching the Python dicts (rerank_score/vector_score/signals). */
export interface GroundingResult {
  rerank_score?: number | null;
  vector_score?: number | null;
  signals?:      string[];
}

/** Faithful port of confidence_tier over loose dict results. */
export function confidenceTierFromResults (
  results: GroundingResult[],
  reranked = true,
): ConfidenceTier {
  if (results.length === 0)
    return 'low'

  let top = results[0].rerank_score ?? results[0].vector_score ?? 0
  if (top == null)
    top = 0

  const agree       = results.slice(0, 3).some(r => (r.signals?.length ?? 0) >= 2)
  const [ hi, med ] = reranked ? [ RERANK_HIGH, RERANK_MED ] : [ COSINE_HIGH, COSINE_MED ]
  if (top >= hi || top >= med && agree)
    return 'high'
  if (top >= med || agree)
    return 'medium'
  return 'low'
}

/** Typed contract over SearchHit[]: uses rerank score when present, else dense. */
export function confidenceTier (hits: SearchHit[]): ConfidenceTier {
  if (hits.length === 0)
    return 'low'

  const reranked                   = hits[0].rerank != null
  const results: GroundingResult[] = hits.map(h => ({
    rerank_score: h.rerank ?? null,
    vector_score: h.dense,
    signals:      [ h.dense > 0 ? 'dense' : '', h.sparse > 0 ? 'lexical' : '' ].filter(Boolean),
  }))
  return confidenceTierFromResults(results, reranked)
}

export interface VerifyClaimResult {
  supported:    boolean;
  score:        number;
  source_index: number;
}

/** Lexical recall of claim terms against the best-matching source. Model-free. */
export function verifyClaim (claim: string, sources: string[], threshold = 0.3): VerifyClaimResult {
  const cterms = new Set(tokenize(claim))
  if (cterms.size === 0)
    return { supported: false, score: 0, source_index: -1 }

  let bestScore = 0
  let bestIdx   = -1
  sources.forEach((src, i) => {
    const sterms = new Set(tokenize(src))
    let inter = 0
    for (const t of cterms)
      if (sterms.has(t))
        inter++

    const overlap = inter / cterms.size
    if (overlap > bestScore) {
      bestScore = overlap
      bestIdx = i
    }
  })
  return {
    supported:    bestScore >= threshold,
    score:        Math.round(bestScore * 1000) / 1000,
    source_index: bestScore >= threshold ? bestIdx : -1,
  }
}

export interface SignalSummary {
  dense:   number;
  lexical: number;
  both:    number;
  total:   number;
}

export function signalSummary (hits: SearchHit[]): SignalSummary {
  const dense   = hits.filter(h => h.dense > 0).length
  const lexical = hits.filter(h => h.sparse > 0).length
  const both    = hits.filter(h => h.dense > 0 && h.sparse > 0).length
  return { dense, lexical, both, total: hits.length }
}
