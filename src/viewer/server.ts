/**
 * 3D synapse viewer server (TypeScript port of viewer_server.py).
 *
 * Serves assets/viewer.html plus a tiny JSON API over a project's vector index:
 *   GET /                       the viewer page
 *   GET /api/status             live index status (name, doc_count, ...)
 *   GET /api/graph?n=400&k=3    sampled chunks + knn synapse links; positions
 *                               are a PCA(3) projection of the real embeddings
 *   GET /api/search?q=...       reranked search; hits carry a graph_index when
 *                               already sampled, else PCA coords + attach links
 *
 * Built on node:http (runs under Bun). PCA via the ml-pca package.
 */
import { createServer } from 'node:http'
import { VIEWER_PORT } from '../config.ts'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PCA } from 'ml-pca'

import { q, q1, toVector } from '../db/pool.ts'
import { getProject, listProjects } from '../db/projects.ts'
import { searchProject } from '../search/search.ts'


const HERE = dirname(fileURLToPath(import.meta.url))

/** Locate viewer.html relative to this module, falling back to the skill path. */
function viewerHtmlPath (): string {
  const candidates = [
    join(HERE, '..', '..', 'assets', 'viewer.html'),
    join(HERE, '..', '..', 'skills', 'vector-index', 'assets', 'viewer.html'),
  ]
  for (const c of candidates)
    if (existsSync(c))
      return c
  throw new Error('viewer.html not found in assets/')
}

interface ProjectCtx {
  id:         string;
  name:       string;
  embedModel: string;
  embTable:   string;
}

interface GraphNode {
  id:        string;
  title:     string;
  source:    string;
  source_id: string;
  url:       string | null;
  chunk:     number;
  unit_type: string;
  snippet:   string;
  p:         [number, number, number];
}

// Fitted PCA state retained between /api/graph and /api/search so search hits
//  can be projected into the same 3D space the graph was laid out in.
interface GraphState {
  idToIdx: Map<string, number>;
  vecs:    number[][];
  pca:     PCA | null;
  scale:   number;
}

const graphState: GraphState = { idToIdx: new Map(), vecs: [], pca: null, scale: 1 }

async function resolveCtx (projectName: string): Promise<ProjectCtx> {
  const proj = await getProject(projectName)
  if (!proj)
    throw new Error(`project not found: ${projectName}`)

  const space = await q1<{ table_name: string }>(
    'SELECT table_name FROM embedding_space WHERE id = $1',
    [ proj.space_id ],
  )
  if (!space)
    throw new Error(`embedding space not found for project ${projectName}`)
  return { id: proj.id, name: proj.name, embedModel: proj.embed_model, embTable: space.table_name }
}

interface ChunkRow {
  id:        string;
  title:     string | null;
  text:      string | null;
  url:       string | null;
  unit_type: string | null;
  ordinal:   number | null;
  embedding: string;
}

/** Sample up to n embedded chunks at random across the index. */
async function sampleChunks (ctx: ProjectCtx, n: number): Promise<ChunkRow[]> {
  return q<ChunkRow>(
    `SELECT c.id, c.title, c.text, c.url, c.unit_type, c.ordinal, e.embedding
     FROM chunk c
     JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
     WHERE c.project_id = $1 AND c.embedding_id IS NOT NULL
     ORDER BY random()
     LIMIT $2`,
    [ ctx.id, n ],
  )
}

/** Parse a pgvector text literal "[a,b,c]" into a number[]. */
function parseVector (v: string | number[]): number[] {
  if (Array.isArray(v))
    return v as number[]
  return v.replace(/^\[|\]$/g, '').split(',')
    .map(Number)
}

function dot (a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++)
    s += a[i]! * b[i]!
  return s
}

function snippet (text: string | null, len = 240): string {
  return (text ?? '').split(/\s+/).filter(Boolean)
    .join(' ')
    .slice(0, len)
}

interface GraphResult {
  nodes: GraphNode[];
  links: [number, number, number][];
  k:     number;
}

// Build the sampled graph: PCA(3) positions + knn synapse links. Mirrors
//  build_graph() in viewer_server.py (numpy SVD -> ml-pca SVD here).
async function buildGraph (ctx: ProjectCtx, n: number, k: number): Promise<GraphResult> {
  const rows = await sampleChunks(ctx, n)
  const vecs = rows.map(r => parseVector(r.embedding))
  if (vecs.length === 0) {
    graphState.idToIdx = new Map()
    graphState.vecs    = []
    graphState.pca     = null
    graphState.scale   = 1
    return { nodes: [], links: [], k }
  }

  // PCA to 3 components (centered by default, matching the numpy mean-subtract).
  const pca  = new PCA(vecs, { method: 'SVD', center: true, scale: false })
  const proj = pca.predict(vecs, { nComponents: 3 }).to2DArray()

  // Normalise the cloud into a ~[-6,6] box (matches scale = 6 / max|pos|).
  let maxAbs = 1e-6
  for (const row of proj)
    for (const x of row)
      maxAbs = Math.max(maxAbs, Math.abs(x))

  const scale = 6.0 / maxAbs

  // k nearest neighbours by cosine/inner-product similarity (vectors are unit-norm).
  const N                                 = vecs.length
  const links: [number, number, number][] = []
  const seen                              = new Set<string>()
  const kk                                = Math.min(k, N - 1)
  for (let i = 0; i < N; i++) {
    const sims: [number, number][] = []
    for (let j = 0; j < N; j++) {
      if (i === j)
        continue
      sims.push([ dot(vecs[i]!, vecs[j]!), j ])
    }
    sims.sort((a, b) => b[0] - a[0])
    for (let m = 0; m < kk; m++) {
      const j   = sims[m]![1]
      const a   = Math.min(i, j)
      const b   = Math.max(i, j)
      const key = `${a}-${b}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push([ a, b, Math.round(sims[m]![0] * 1e4) / 1e4 ])
      }
    }
  }

  const nodes: GraphNode[] = rows.map((r, i) => ({
    id:        r.id,
    title:     r.title ?? '',
    source:    r.title ?? '',
    source_id: '',
    url:       r.url ?? null,
    chunk:     r.ordinal ?? 0,
    unit_type: r.unit_type ?? '',
    snippet:   snippet(r.text),
    p:         [
      Math.round(proj[i]![0]! * scale * 1e4) / 1e4,
      Math.round(proj[i]![1]! * scale * 1e4) / 1e4,
      Math.round(proj[i]![2]! * scale * 1e4) / 1e4,
    ],
  }))

  graphState.idToIdx = new Map(rows.map((r, i) => [ r.id, i ]))
  graphState.vecs    = vecs
  graphState.pca     = pca
  graphState.scale   = scale

  return { nodes, links, k }
}

/** Project a single vector into the current graph's PCA space. */
function projectVec (vec: number[]): [number, number, number] {
  if (!graphState.pca)
    return [ 0, 0, 0 ]

  const row = graphState.pca.predict([ vec ], { nComponents: 3 }).to2DArray()[0]!
  return [
    Math.round(row[0]! * graphState.scale * 1e4) / 1e4,
    Math.round(row[1]! * graphState.scale * 1e4) / 1e4,
    Math.round(row[2]! * graphState.scale * 1e4) / 1e4,
  ]
}

interface SearchEntry {
  id:            string;
  title:         string | null;
  source:        string;
  url:           string | null;
  chunk:         number;
  unit_type:     string | null;
  score:         number;
  rerank_score?: number;
  signals?:      string[];
  graph_index?:  number;
  p?:            [number, number, number];
  attach?:       [number, number][];
}

// Run searchProject and shape hits for the viewer: splice into the sampled
//  graph when already present, else carry PCA coords + nearest attach links.
async function runSearch (ctx: ProjectCtx, query: string): Promise<{ query: string; results: SearchEntry[] }> {
  const res = await searchProject(query, ctx.name, { topk: 8 })
  // Fetch embeddings for hits not already in the sampled graph so we can place them.
  const missing = res.hits.filter(h => !graphState.idToIdx.has(h.chunk_id)).map(h => h.chunk_id)
  const vecById = new Map<string, number[]>()
  if (missing.length) {
    const rows = await q<{ id: string; embedding: string }>(
      `SELECT c.id, e.embedding
       FROM chunk c JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
       WHERE c.id = ANY($1)`,
      [ missing ],
    )
    for (const r of rows)
      vecById.set(r.id, parseVector(r.embedding))
  }

  const results: SearchEntry[] = res.hits.map(h => {
    const entry: SearchEntry = {
      id:        h.chunk_id,
      title:     h.title,
      source:    h.title ?? '',
      url:       h.url,
      chunk:     h.ordinal,
      unit_type: h.unit_type,
      score:     h.score,
      signals:   [ h.dense > 0 ? 'dense' : '', h.sparse > 0 ? 'sparse' : '' ].filter(Boolean),
    }
    if (h.rerank != null)
      entry.rerank_score = h.rerank

    const gi = graphState.idToIdx.get(h.chunk_id)
    if (gi != null)
      entry.graph_index = gi; else {
      const vec = vecById.get(h.chunk_id)
      if (vec) {
        entry.p = projectVec(vec)
        if (graphState.vecs.length) {
          const sims = graphState.vecs.map((gv, i) => [ dot(gv, vec), i ] as [number, number])
          sims.sort((a, b) => b[0] - a[0])
          entry.attach = sims.slice(0, 3).map(([ s, i ]) => [ i, Math.round(s * 1e4) / 1e4 ])
        }
      }
    }
    return entry
  })

  return { query, results }
}

interface StatusResult {
  name:        string;
  doc_count:   number;
  embed_model: string;
  state:       string;
}

async function buildStatus (ctx: ProjectCtx): Promise<StatusResult> {
  const counts = await q1<{ chunks: number; embedded: number; documents: number }>(
    `SELECT count(c.id)::int AS chunks,
            count(c.embedding_id)::int AS embedded,
            count(DISTINCT c.document_id)::int AS documents
     FROM chunk c WHERE c.project_id = $1`,
    [ ctx.id ],
  )
  const chunks   = counts?.chunks ?? 0
  const embedded = counts?.embedded ?? 0
  return {
    name:        ctx.name,
    doc_count:   chunks,
    embed_model: ctx.embedModel,
    state:       embedded >= chunks ? 'ready' : `embedding ${embedded}/${chunks}`,
  }
}

const DEFAULT_PORT = VIEWER_PORT

/** Start the viewer HTTP server for `projectName`. Resolves once listening. */
export async function runViewer (projectName: string, port: number = DEFAULT_PORT): Promise<void> {
  const ctx      = await resolveCtx(projectName)
  const htmlPath = viewerHtmlPath()

  const server = createServer((req, res) => {
    const url      = new URL(req.url ?? '/', 'http://localhost')
    const sendJson = (obj: unknown, code = 200) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-store',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(body)
    }

    // eslint-disable-next-line complexity -- request handler dispatches several /api routes
    void (async () => {
      try {
        const path = url.pathname
        if (path === '/' || path === '/index.html') {
          const body = await readFile(htmlPath)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(body)
        }
        else if (path === '/api/status')
          sendJson(await buildStatus(ctx)); else if (path === '/api/graph') {
          const n = Math.min(1200, Math.max(50, Number(url.searchParams.get('n') ?? '400') || 400))
          const k = Math.min(6, Math.max(1, Number(url.searchParams.get('k') ?? '3') || 3))
          sendJson(await buildGraph(ctx, n, k))
        }
        else if (path === '/api/search') {
          const query = (url.searchParams.get('q') ?? '').trim()
          if (!query)
            sendJson({ error: 'empty query' }, 400)
          else
            sendJson(await runSearch(ctx, query))
        }
        else
          sendJson({ error: 'not found' }, 404)
      }
      catch (err) {
        try {
          sendJson({ error: err instanceof Error ? err.message : String(err) }, 500)
        }
        catch {

          /* socket gone */
        }
      }
    })()
  })

  await new Promise<void>(resolve => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`synapse viewer (${ctx.name})  ->  http://localhost:${port}`)
      resolve()
    })
  })
}

if (import.meta.main) {
  const name = process.argv[2] || (await listProjects())[0]?.name
  if (!name) {
    console.error('no project to serve')
    process.exit(1)
  }
  await runViewer(name)
}
