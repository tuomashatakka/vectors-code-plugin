/**
 * assemble — token-budgeted context assembly (C7).
 *
 * Final retrieval step: greedily keep the highest-ranked hits whose running
 * token total fits a budget, deduplicating by normalized content so a chunk and
 * an identical message aren't both spent. The single best hit is always kept,
 * even if it alone exceeds the budget (some context beats none).
 *
 * Token estimate is a fast heuristic — ~text.length/4 characters per token, no
 * tokenizer dependency. Callers needing exact counts can inject their own.
 */
import type { SearchHit } from '../db/types.ts'

/** ~4 chars per token — close enough for budgeting, zero dependencies. */
export function approxTokens (text: string): number {
  const len = (text || '').trim().length
  return len === 0 ? 0 : Math.max(1, Math.round(len / 4))
}

/** Collapse whitespace to form a dedupe signature for a chunk's content. */
function contentSignature (text: string): string {
  return (text || '').split(/\s+/).filter(Boolean)
    .join(' ')
}

/**
 * Keep hits in order until `maxTokens` is reached; dedupe by content. Returns
 * the kept hits (each annotated with a `token_count`). `maxTokens <= 0` means
 * "no limit" — just dedupe and annotate.
 */
export function assembleWithinBudget (
  hits: SearchHit[],
  maxTokens = 0,
  counter: (text: string) => number = approxTokens,
): Array<SearchHit & { token_count: number }> {
  const out: Array<SearchHit & { token_count: number }> = []
  const seen                                            = new Set<string>()
  let total = 0
  for (const hit of hits) {
    const text = hit.text || ''
    const sig  = contentSignature(text)
    if (seen.has(sig))
      continue

    const n = counter(text)
    if (maxTokens > 0 && out.length > 0 && total + n > maxTokens)
      break
    seen.add(sig)
    out.push({ ...hit, token_count: n })
    total += n
  }
  return out
}

/** Total estimated tokens across the assembled hits. */
export function assembledTokens (
  hits: Array<{ token_count: number }>,
): number {
  return hits.reduce((sum, h) => sum + h.token_count, 0)
}
