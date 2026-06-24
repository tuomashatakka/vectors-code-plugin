/**
 * Hybrid search: a dense leg (pgvector cosine ANN) fused with a sparse leg
 * (Postgres FTS / ts_rank, replacing the old BM25 sidecar) via Reciprocal Rank
 * Fusion, then an optional cross-encoder rerank, a confidence tier, and trimming
 * to topk. Global search fans the same pipeline across every project and merges.
 */
import { q, q1, toVector } from '../db/pool.ts'
import { getProject, listProjects } from '../db/projects.ts'
import { embedOne } from '../embed/embedder.ts'
import { rerank } from '../embed/rerank.ts'
import { confidenceTier } from './grounding.ts'
import type { SearchHit, SearchResult, UnitType } from '../db/types.ts'


const RRF_K = 60

interface LegRow {
  chunk_id:    string;
  document_id: string;
  project:     string;
  ordinal:     number;
  title:       string | null;
  text:        string;
  url:         string | null;
  unit_type:   UnitType | null;
  metric:      number;
}

async function spaceTable (spaceId: string): Promise<string> {
  const row = await q1<{ table_name: string }>(
    'SELECT table_name FROM embedding_space WHERE id = $1',
    [ spaceId ],
  )
  return row!.table_name
}

const COLS = `c.id AS chunk_id, c.document_id, p.name AS project, c.ordinal,
              c.title, c.text, c.url, c.unit_type`

/** Dense + sparse legs for ONE project, fused with RRF. No rerank applied. */
async function searchHits (
  qvec: number[],
  projectId: string,
  embTable: string,
  fetchK: number,
  query: string,
): Promise<Map<string, SearchHit>> {
  const vec = toVector(qvec)

  const dense = await q<LegRow>(
    `SELECT ${COLS}, 1 - (e.embedding <=> $1::vector) AS metric
     FROM chunk c
     JOIN project p ON p.id = c.project_id
     JOIN ${embTable} e ON e.embedding_id = c.embedding_id
     WHERE c.project_id = $2 AND c.embedding_id IS NOT NULL
     ORDER BY e.embedding <=> $1::vector
     LIMIT $3`,
    [ vec, projectId, fetchK ],
  )

  const sparse = await q<LegRow>(
    `SELECT ${COLS}, ts_rank(c.tsv, websearch_to_tsquery('english', $1)) AS metric
     FROM chunk c
     JOIN project p ON p.id = c.project_id
     WHERE c.project_id = $2 AND c.tsv @@ websearch_to_tsquery('english', $1)
     ORDER BY metric DESC
     LIMIT $3`,
    [ query, projectId, fetchK ],
  )

  const hits   = new Map<string, SearchHit>()
  const ensure = (r: LegRow): SearchHit => {
    let h = hits.get(r.chunk_id)
    if (!h) {
      h = {
        chunk_id:    r.chunk_id,
        document_id: r.document_id,
        project:     r.project,
        ordinal:     r.ordinal,
        title:       r.title,
        text:        r.text,
        url:         r.url,
        unit_type:   r.unit_type,
        dense:       0,
        sparse:      0,
        rrf:         0,
        score:       0,
      }
      hits.set(r.chunk_id, h)
    }
    return h
  }

  dense.forEach((r, i) => {
    const h = ensure(r)
    h.dense = Number(r.metric)
    h.rrf += 1 / (RRF_K + i + 1)
  })
  sparse.forEach((r, i) => {
    const h  = ensure(r)
    h.sparse = Number(r.metric)
    h.rrf += 1 / (RRF_K + i + 1)
  })
  for (const h of hits.values())
    h.score = h.rrf
  return hits
}

async function finalize (
  query: string,
  hits: SearchHit[],
  rerankModel: string | null,
  topk: number,
  doRerank: boolean,
): Promise<SearchHit[]> {
  let ranked = hits.sort((a, b) => b.rrf - a.rrf)
  if (doRerank && rerankModel && ranked.length > 1) {
    const pool   = ranked.slice(0, Math.max(topk * 3, topk))
    const scores = await rerank(query, pool.map(h => h.text), rerankModel)
    pool.forEach((h, i) => {
      h.rerank = scores[i]
      h.score  = scores[i]
    })
    ranked = pool.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0))
  }
  return ranked.slice(0, topk)
}

export interface SearchOpts {
  topk?:   number;
  rerank?: boolean;
}

/** Search a single project. */
export async function searchProject (
  query: string,
  projectName: string,
  opts: SearchOpts = {},
): Promise<SearchResult> {
  const topk     = opts.topk ?? 8
  const doRerank = opts.rerank ?? true
  const proj     = await getProject(projectName)
  if (!proj)
    return { query, project: projectName, hits: [], confidence: 'low', agreement: false }

  const embTable   = await spaceTable(proj.space_id)
  const qvec       = await embedOne(query, proj.embed_model)
  const hitMap     = await searchHits(qvec, proj.id, embTable, topk * 4, query)
  const hits       = await finalize(query, [ ...hitMap.values() ], doRerank ? proj.rerank_model : null, topk, doRerank)
  const confidence = confidenceTier(hits)
  const agreement  = hits.slice(0, 3).some(h => h.dense > 0 && h.sparse > 0)
  return { query, project: projectName, hits, confidence, agreement }
}

/** Global search across every project (or a provided subset). */
export async function searchGlobal (
  query: string,
  opts: SearchOpts & { projects?: string[] } = {},
): Promise<SearchResult> {
  const topk     = opts.topk ?? 8
  const doRerank = opts.rerank ?? true
  const names    = opts.projects?.length
    ? opts.projects
    : (await listProjects()).map(p => p.name)

  const perProject = await Promise.all(
    names.map(async name => {
      const proj = await getProject(name)
      if (!proj)
        return []

      const embTable = await spaceTable(proj.space_id)
      const qvec     = await embedOne(query, proj.embed_model)
      const m        = await searchHits(qvec, proj.id, embTable, topk * 2, query)
      return [ ...m.values() ]
    }),
  )

  const merged     = perProject.flat()
  const hits       = await finalize(query, merged, doRerank ? DEFAULT_RERANK : null, topk, doRerank)
  const confidence = confidenceTier(hits)
  const agreement  = hits.slice(0, 3).some(h => h.dense > 0 && h.sparse > 0)
  return { query, project: '*', hits, confidence, agreement }
}

import { DEFAULT_RERANK_MODEL as DEFAULT_RERANK } from '../config.ts'
