/**
 * orchestration — layered ("Bridge"-pattern) retrieval weighting.
 *
 * Retrieval is modeled as layers — a shared/global knowledge layer plus one or
 * more project-scoped layers — queried together and fused, with the balance
 * shifted by what the query asks. "What do WE do about X" leans on the scoped
 * layer; "what does the standard say about X" leans on the shared layer.
 *
 * This supplies the query-intent classifier and the per-layer weights that
 * global search feeds into Reciprocal Rank Fusion.
 */

/** "Ours / here / internal" -> favor the scoped (project) layer. */
const SCOPED_HINTS =
  /\b(our|ours|my|mine|we|us|internal|this (?:project|repo|repository|codebase|file))\b/i

/** "Standard / spec / law / docs / convention" -> favor the shared layer. */
const SHARED_HINTS =
  /\b(standard|spec|specification|law|statute|regulation|reference|documentation|docs|general|convention|best practice|guideline|rfc)\b/i

export type QueryIntent = 'scoped' | 'shared' | 'balanced'
export type Layer = 'scoped' | 'shared'

/** (scopedLayerWeight, sharedLayerWeight) per intent. */
const WEIGHTS: Record<QueryIntent, readonly [number, number]> = {
  scoped:   [ 0.8, 0.2 ],
  shared:   [ 0.2, 0.8 ],
  balanced: [ 0.5, 0.5 ],
}

/** Return 'scoped' | 'shared' | 'balanced' from lexical hints in the query. */
export function classifyQueryIntent (query: string): QueryIntent {
  const text   = query || ''
  const scoped = SCOPED_HINTS.test(text)
  const shared = SHARED_HINTS.test(text)
  if (scoped && !shared)
    return 'scoped'
  if (shared && !scoped)
    return 'shared'
  return 'balanced'
}

/** (scopedWeight, sharedWeight) for the given intent. */
export function layerWeights (intent: QueryIntent | string): readonly [number, number] {
  return WEIGHTS[intent as QueryIntent] ?? WEIGHTS.balanced
}

/**
 * Map each project to its fusion weight given which projects form the shared
 * layer and the query intent. With no shared layer declared, every project is
 * weighted equally (the Pool behavior).
 */
export function projectWeights (
  projectNames: string[],
  shared: string[] | null | undefined,
  intent: QueryIntent | string,
): Record<string, number> {
  const sharedSet = new Set(shared ?? [])
  if (sharedSet.size === 0)
    return Object.fromEntries(projectNames.map(name => [ name, 1.0 ]))

  const [ scopedW, sharedW ] = layerWeights(intent)
  return Object.fromEntries(
    projectNames.map(name => [ name, sharedSet.has(name) ? sharedW : scopedW ]),
  )
}

/** Which layer a named project belongs to. */
export function layerOf (name: string, shared: string[] | null | undefined): Layer {
  return new Set(shared ?? []).has(name) ? 'shared' : 'scoped'
}
