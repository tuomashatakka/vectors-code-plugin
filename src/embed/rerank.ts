/**
 * Cross-encoder reranking via Transformers.js — the Node replacement for the
 * sentence-transformers CrossEncoder. Scores (query, passage) pairs with a
 * sequence-classification head and returns a relevance logit per passage.
 */
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  env


} from '@xenova/transformers'
import type { PreTrainedTokenizer, PreTrainedModel } from '@xenova/transformers'
import { DEFAULT_RERANK_MODEL } from '../config.ts'

// See src/embed/embedder.ts — forces single-threaded WASM so a construction-error
// fallback can never spawn onnxruntime-web's browser-only Blob/Worker bootstrap.
env.backends.onnx.wasm.numThreads = 1

/** Map the logical cross-encoder name to its Transformers.js ONNX repo. */
export function toXenovaReranker (model: string): string {
  if (model.startsWith('Xenova/'))
    return model

  // cross-encoder/ms-marco-MiniLM-L6-v2 -> Xenova/ms-marco-MiniLM-L-6-v2
  const tail       = model.split('/').pop() ?? model
  const normalized = tail.replace(/MiniLM-L(\d+)-v2/i, 'MiniLM-L-$1-v2')
  return `Xenova/${normalized}`
}

type Loaded = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel }

const cache = new Map<string, Promise<Loaded>>()

function load (model: string): Promise<Loaded> {
  const repo = toXenovaReranker(model)
  let p = cache.get(repo)
  if (!p) {
    p = (async () => ({
      tokenizer: await AutoTokenizer.from_pretrained(repo),
      model:     await AutoModelForSequenceClassification.from_pretrained(repo),
    }))()
    cache.set(repo, p)
  }
  return p
}

/**
 * Score each passage against the query. Higher = more relevant. Returns scores
 * aligned with `passages`. Empty input -> empty output.
 */
export async function rerank (
  query: string,
  passages: string[],
  model = DEFAULT_RERANK_MODEL,
): Promise<number[]> {
  if (passages.length === 0)
    return []

  const { tokenizer, model: seqcls } = await load(model)
  const inputs                       = tokenizer(new Array(passages.length).fill(query), {
    text_pair:  passages,
    padding:    true,
    truncation: true,
  })
  const { logits } = await seqcls(inputs)
  // ms-marco rerankers emit a single relevance logit per pair: shape [n, 1].
  const data = logits.tolist() as number[][]
  return data.map(row => row[0])
}

/** Rerank an array of items by a text accessor, returning them sorted desc with scores. */
export async function rerankBy<T> (
  query: string,
  items: T[],
  text: (item: T) => string,
  model = DEFAULT_RERANK_MODEL,
): Promise<Array<{ item: T; score: number }>> {
  const scores = await rerank(query, items.map(text), model)
  return items
    .map((item, i) => ({ item, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
}
