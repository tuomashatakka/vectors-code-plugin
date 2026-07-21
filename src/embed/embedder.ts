/**
 * Local embeddings via Transformers.js (ONNX) — the Node replacement for the
 * Python sentence-transformers stack, with NO torch. Default model is the same
 * all-MiniLM-L6-v2 (384-dim) so the vectors are dimensionally identical; output
 * is mean-pooled + L2-normalized so cosine == inner product, matching the DDL.
 */
import { pipeline, env } from '@xenova/transformers'
import type { FeatureExtractionPipeline } from '@xenova/transformers'
import { DEFAULT_EMBED_MODEL } from '../config.ts'

// Keep model downloads in the same HF cache the Python stack used.
env.allowLocalModels = true

// Bun satisfies onnxruntime's node-vs-web check, but any construction-error
// fallback still lands on onnxruntime-web's threaded-WASM path, which bootstraps
// worker threads via browser-only Blob URLs — unsupported under Bun. Force
// single-threaded WASM so that path can never spawn a worker.
env.backends.onnx.wasm.numThreads = 1

/** Map a sentence-transformers logical name to its Transformers.js ONNX repo. */
export function toXenovaRepo (model: string): string {
  if (model.includes('/'))
    return model.startsWith('Xenova/') ? model : `Xenova/${model.split('/').pop()}`
  return `Xenova/${model}`
}

const cache = new Map<string, Promise<FeatureExtractionPipeline>>()

function getPipeline (model: string): Promise<FeatureExtractionPipeline> {
  const repo = toXenovaRepo(model)
  let p = cache.get(repo)
  if (!p) {
    p = pipeline('feature-extraction', repo) as Promise<FeatureExtractionPipeline>
    cache.set(repo, p)
  }
  return p
}

/** Embed a batch of texts. Returns one Float32-style number[] per input. */
export async function embed (
  texts: string[],
  model = DEFAULT_EMBED_MODEL,
): Promise<number[][]> {
  if (texts.length === 0)
    return []

  const extractor = await getPipeline(model)
  const out       = await extractor(texts, { pooling: 'mean', normalize: true })
  // out is a [n, dim] Tensor; tolist() yields number[][].
  return out.tolist() as number[][]
}

/** Embed a single text. */
export async function embedOne (text: string, model = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const [ v ] = await embed([ text ], model)
  return v
}

/** Embedding dimensionality for a model (probes once, cached). */
const dimCache = new Map<string, number>()

export async function embedDim (model = DEFAULT_EMBED_MODEL): Promise<number> {
  const repo = toXenovaRepo(model)
  let d = dimCache.get(repo)
  if (d === undefined) {
    const [ v ] = await embed([ 'probe' ], model)
    d = v.length
    dimCache.set(repo, d)
  }
  return d
}
