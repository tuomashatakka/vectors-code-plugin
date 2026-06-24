/**
 * references — extract, validate, and ground external references / citations.
 *
 * Pull references (URLs and citation-shaped tokens) out of text, then validate
 * each — against the indexed corpus (does this citation actually appear in what
 * we know?) or, opt-in and off the hot path, against the live network.
 * Unverifiable references are flagged `[UNVERIFIED]`, the defense against
 * hallucinated citations.
 *
 * The corpus check takes an injected `searchFn`, decoupling it from the engine
 * (unit-testable with a fake searcher); network resolution is opt-in.
 */

const URL_RE = /https?:\/\/[^\s)<>\]"']+/g

/**
 * Generic citation shapes: "228/1929", "KPL 3:9.2", "RFC 7231", "ISO 8601",
 * "SECTION 36". Domain callers can pass extra patterns.
 */
const CITATION_RES: RegExp[] = [
  /\b\d{1,5}\/\d{2,4}\b/g, // number/year
  /\b[A-Z]{2,6}\s?\d+(?::\d+(?:\.\d+)*)?\b/g, // CODE 3:9.2 / RFC 7231
  /§\s?\d+[a-z]?/g, // section-sign 36
]

/**
 * Real URLs/citations are short. An over-long match is almost always a minified
 * line or embedded blob — and would overflow the unified-DB's btree
 * UNIQUE(kind, uri) index (~2704-byte limit), killing the extract job.
 */
const MAX_URI = 2048

export type RefKind = 'url' | 'citation'
export interface Reference {
  kind: RefKind;
  uri:  string;
}

/** A corpus result row as the engine returns it (shape-compatible subset). */
export interface SearchResultRow {
  text?:         string;
  source?:       string | null;
  url?:          string | null;
  rerank_score?: number | null;
  vector_score?: number | null;
}
export interface SearchFnResult {
  results?: SearchResultRow[];
}
export type SearchFn = (
  query: string,
  topk: number,
) => SearchFnResult | null | undefined

/** Ensure a regex is global so `matchAll` yields every occurrence. */
function asGlobal (re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, re.flags + 'g')
}

/** Return de-duplicated [{kind, uri}] for URLs and citation-shaped tokens. */
export function extractReferences (
  text: string,
  patterns?: RegExp[],
): Reference[] {
  const out: Reference[] = []
  const seen             = new Set<string>()

  const add = (kind: RefKind, uri: string) => {
    if (!uri || uri.length > MAX_URI)
      return

    const key = kind + ' ' + uri
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ kind, uri })
    }
  }

  const src = text || ''
  for (const m of src.matchAll(asGlobal(URL_RE)))
    add('url', m[0].replace(/[.,);]+$/, ''))
  for (const pat of patterns ?? CITATION_RES)
    for (const m of src.matchAll(asGlobal(pat)))
      add('citation', m[0].trim())
  return out
}

export interface CitationVerdict {
  kind:     RefKind;
  uri:      string;
  verified: boolean;
  source:   string | null;
}
export interface CitationReport {
  references: CitationVerdict[];
  verified:   number;
  unverified: number;
  annotated:  string;
}

/**
 * Check every reference in `text` against the corpus via `searchFn`. A reference
 * is verified when it appears verbatim in a retrieved chunk, or a retrieved
 * chunk clears `threshold` on rerank/vector score. Returns per-reference
 * verdicts plus a copy of the text with unverifiable refs marked `[UNVERIFIED]`.
 */
// eslint-disable-next-line complexity -- citation verification fans over several ref shapes
export function validateCitations (
  text: string,
  searchFn: SearchFn,
  opts: { threshold?: number; topk?: number; patterns?: RegExp[] } = {},
): CitationReport {
  const { threshold = 0.0, topk = 5, patterns } = opts
  const refs                                    = extractReferences(text, patterns)
  let annotated = text
  const verdicts: CitationVerdict[] = []

  for (const ref of refs) {
    const uri      = ref.uri
    const res      = searchFn(uri, topk) || {}
    const results  = res.results ?? []
    const verbatim = results.find(r =>
      (r.text ?? '').toLowerCase().includes(uri.toLowerCase()),
    )
    let ok: boolean
    let source: string | null
    if (verbatim) {
      ok = true
      source = verbatim.source ?? verbatim.url ?? null
    }
    else if (results.length > 0) {
      const top   = results[0]
      const score = top.rerank_score ?? top.vector_score ?? 0.0
      ok = score != null && score >= threshold
      source = ok ? top.source ?? top.url ?? null : null
    }
    else {
      ok = false
      source = null
    }
    verdicts.push({ kind: ref.kind, uri, verified: ok, source })
    if (!ok)
      annotated = annotated.split(uri).join(uri + ' [UNVERIFIED]')
  }

  const nOk = verdicts.filter(v => v.verified).length
  return {
    references: verdicts,
    verified:   nOk,
    unverified: verdicts.length - nOk,
    annotated,
  }
}

export interface ResolveResult {
  uri:       string;
  checked:   boolean;
  reachable: boolean | null;
  status?:   number;
  error?:    string;
}

/**
 * Optionally validate a URL is live (HEAD request). Off by default to honor the
 * plugin's no-network-at-query-time guarantee; callers opt in explicitly.
 */
export async function resolveReference (
  uri: string,
  opts: { timeout?: number; network?: boolean } = {},
): Promise<ResolveResult> {
  const { timeout = 8.0, network = false } = opts
  const lower                              = uri.toLowerCase()
  if (
    !network ||
    !(lower.startsWith('http://') || lower.startsWith('https://'))
  )
    return { uri, checked: false, reachable: null }

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000)
  try {
    const resp = await fetch(uri, {
      method:  'HEAD',
      headers: { 'User-Agent': 'vectors-plugin' },
      signal:  ctrl.signal,
    })
    return { uri, checked: true, reachable: true, status: resp.status }
  }
  catch (e) {
    return {
      uri,
      checked:   true,
      reachable: false,
      error:     String(e instanceof Error ? e.message : e).slice(0, 200),
    }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Groundedness convenience: given a `corpus` of strings, report which references
 * in `text` appear verbatim within any corpus entry. Wraps `validateCitations`
 * with a trivial in-memory searcher.
 */
export function checkGroundedness (
  text: string,
  corpus: string[],
): CitationReport {
  const searchFn: SearchFn = query => ({
    results: corpus
      .filter(c => c.toLowerCase().includes(query.toLowerCase()))
      .map(c => ({ text: c, source: null })),
  })
  return validateCitations(text, searchFn)
}
