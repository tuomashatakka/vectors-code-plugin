/**
 * 3D synapse viewer server (TypeScript port of viewer_server.py).
 *
 * Serves assets/viewer.html plus a tiny JSON API over a project's vector index:
 *   GET /                       the viewer page
 *   GET /api/status             live index status (name, documents, chunks, ...)
 *   GET /api/inventory          data inventory: sources + paginated documents + global projects
 *   GET /api/doc?id=...         one document's chunk listing (inventory drill-down leaf)
 *   GET /api/node?id=...        full chunk detail: text, references, siblings, PCA relations
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
import { getProject, getSources, listProjects } from '../db/projects.ts'
import { searchProject } from '../search/search.ts'
import type { SourceConfig } from '../db/types.ts'
import type { ProjectSummary } from '../db/projects.ts'


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

export interface ProjectCtx {
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

export async function resolveCtx (projectName: string): Promise<ProjectCtx> {
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

export interface GraphResult {
  nodes: GraphNode[];
  links: [number, number, number][];
  k:     number;
}

// Build the sampled graph: PCA(3) positions + knn synapse links. Mirrors
//  build_graph() in viewer_server.py (numpy SVD -> ml-pca SVD here).
export async function buildGraph (ctx: ProjectCtx, n: number, k: number): Promise<GraphResult> {
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
  documents:   number;
  chunks:      number;
  embedded:    number;
  embed_model: string;
  state:       string;
}

export async function buildStatus (ctx: ProjectCtx): Promise<StatusResult> {
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
    doc_count:   chunks, // kept as the chunk count for older baked static payloads
    documents:   counts?.documents ?? 0,
    chunks,
    embedded,
    embed_model: ctx.embedModel,
    state:       embedded >= chunks ? 'ready' : `embedding ${embedded}/${chunks}`,
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface InventoryDoc {
  id:        string;
  source_id: string | null;
  rel_path:  string | null;
  title:     string | null;
  url:       string | null;
  mtime:     string | null;
  chunks:    number;
}

interface InventoryResult {
  project: {
    name:        string;
    embed_model: string;
    documents:   number;
    chunks:      number;
    embedded:    number;
    state:       string;
    sources:     SourceConfig[];
    docs:        InventoryDoc[];
    docs_total:  number;
    offset:      number;
    limit:       number;
  };
  global: ProjectSummary[];
}

/** Full data inventory: project sources + paginated documents + global project list. */
export async function buildInventory (ctx: ProjectCtx, limit: number, offset: number): Promise<InventoryResult> {
  const status  = await buildStatus(ctx)
  const sources = await getSources(ctx.name)
  const docs    = await q<InventoryDoc>(
    `SELECT d.id, d.source_id, d.rel_path, d.title, d.url, d.mtime,
            (SELECT count(*) FROM chunk c WHERE c.document_id = d.id)::int AS chunks
     FROM document d WHERE d.project_id = $1
     ORDER BY d.source_id, d.rel_path
     LIMIT $2 OFFSET $3`,
    [ ctx.id, limit, offset ],
  )
  return {
    project: {
      name:        ctx.name,
      embed_model: ctx.embedModel,
      documents:   status.documents,
      chunks:      status.chunks,
      embedded:    status.embedded,
      state:       status.state,
      sources,
      docs,
      docs_total:  status.documents,
      offset,
      limit,
    },
    global: await listProjects(),
  }
}

interface DocResult {
  id:       string;
  rel_path: string | null;
  title:    string | null;
  chunks:   { id: string;
    ordinal:      number;
    title:        string | null;
    unit_type:    string | null;
    token_count:  number | null;
    embedded:     boolean; }[];
}

/** One document's chunk listing — the drill-down leaf of the inventory tree. */
export async function buildDoc (ctx: ProjectCtx, id: string): Promise<DocResult | null> {
  if (!UUID_RE.test(id))
    return null

  const doc = await q1<{ id: string; rel_path: string | null; title: string | null }>(
    'SELECT id, rel_path, title FROM document WHERE id = $1 AND project_id = $2',
    [ id, ctx.id ],
  )
  if (!doc)
    return null

  const chunks = await q<DocResult['chunks'][number]>(
    `SELECT id, ordinal, title, unit_type, token_count,
            (embedding_id IS NOT NULL) AS embedded
     FROM chunk WHERE document_id = $1 ORDER BY ordinal`,
    [ id ],
  )
  return { ...doc, chunks }
}

interface NodeRelation {
  id:           string;
  title:        string | null;
  source:       string;
  chunk:        number;
  unit_type:    string | null;
  score:        number;
  graph_index?: number;
}

interface NodeResult {
  id:         string;
  title:      string | null;
  source:     string;
  source_id:  string;
  chunk:      number;
  unit_type:  string | null;
  url:        string | null;
  text:       string;
  symbol:     string | null;
  char_count: number;
  references: { kind: string; uri: string }[];
  relations:  NodeRelation[];
  document:   { id: string;
    title:          string | null;
    chunk:          number;
    unit_type:      string | null;
    self?:          boolean;
    graph_index?:   number; }[];
}

/** Full node detail for the viewer panel: chunk text, references, siblings, PCA relations. */
export async function buildNode (ctx: ProjectCtx, id: string): Promise<NodeResult | null> {
  if (!UUID_RE.test(id))
    return null

  const row = await q1<{ id: string;
    title:                   string | null;
    text:                    string | null;
    url:                     string | null;
    ordinal:                 number | null;
    unit_type:               string | null;
    symbol:                  string | null;
    document_id:             string;
    rel_path:                string | null;
    source_id:               string | null; }>(
    `SELECT c.id, c.title, c.text, c.url, c.ordinal, c.unit_type, c.symbol, c.document_id,
            d.rel_path, d.source_id
     FROM chunk c JOIN document d ON d.id = c.document_id
     WHERE c.id = $1 AND c.project_id = $2`,
    [ id, ctx.id ],
  )
  if (!row)
    return null

  const references = await q<{ kind: string; uri: string }>(
    `SELECT r.kind, r.uri
     FROM link l JOIN reference r ON r.id = l.dst_id
     WHERE l.src_kind = 'chunk' AND l.src_id = $1 AND l.dst_kind = 'reference'`,
    [ id ],
  )

  const siblings = await q<{ id: string; title: string | null; ordinal: number | null; unit_type: string | null }>(
    'SELECT id, title, ordinal, unit_type FROM chunk WHERE document_id = $1 ORDER BY ordinal',
    [ row.document_id ],
  )
  const document = siblings.map(s => {
    const entry: NodeResult['document'][number] = {
      id:        s.id,
      title:     s.title,
      chunk:     s.ordinal ?? 0,
      unit_type: s.unit_type,
    }
    if (s.id === id)
      entry.self = true

    const gi = graphState.idToIdx.get(s.id)
    if (gi != null)
      entry.graph_index = gi
    return entry
  })

  const relations = await nodeRelations(ctx, id)

  return {
    id:         row.id,
    title:      row.title,
    source:     row.rel_path ?? '',
    source_id:  row.source_id ?? '',
    chunk:      row.ordinal ?? 0,
    unit_type:  row.unit_type,
    url:        row.url,
    text:       row.text ?? '',
    symbol:     row.symbol,
    char_count: (row.text ?? '').length,
    references,
    relations,
    document,
  }
}

/** Top cosine neighbours of a chunk within the currently sampled graph. */
async function nodeRelations (ctx: ProjectCtx, id: string): Promise<NodeRelation[]> {
  if (!graphState.pca || !graphState.vecs.length)
    return []

  const selfIdx = graphState.idToIdx.get(id)
  let vec       = selfIdx != null ? graphState.vecs[selfIdx] : undefined
  if (!vec) {
    const emb = await q1<{ embedding: string }>(
      `SELECT e.embedding FROM chunk c
       JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
       WHERE c.id = $1`,
      [ id ],
    )
    if (!emb)
      return []
    vec = parseVector(emb.embedding)
  }

  const sims = graphState.vecs.map((gv, i) => [ dot(gv, vec), i ] as [number, number])
    .filter(([ , i ]) => i !== selfIdx)
  sims.sort((a, b) => b[0] - a[0])

  const top     = sims.slice(0, 6)
  const idByIdx = new Map<number, string>()
  for (const [ cid, i ] of graphState.idToIdx)
    idByIdx.set(i, cid)

  const ids  = top.map(([ , i ]) => idByIdx.get(i)).filter((x): x is string => x != null)
  const meta = ids.length
    ? await q<{ id: string; title: string | null; ordinal: number | null; unit_type: string | null }>(
      'SELECT id, title, ordinal, unit_type FROM chunk WHERE id = ANY($1)',
      [ ids ],
    )
    : []
  const metaById = new Map(meta.map(m => [ m.id, m ]))

  const out: NodeRelation[] = []
  for (const [ s, i ] of top) {
    const cid = idByIdx.get(i)
    const m   = cid ? metaById.get(cid) : undefined
    if (!cid || !m)
      continue
    out.push({
      id:          cid,
      title:       m.title,
      source:      m.title ?? '',
      chunk:       m.ordinal ?? 0,
      unit_type:   m.unit_type,
      score:       Math.round(s * 1e4) / 1e4,
      graph_index: i,
    })
  }
  return out
}

const DEFAULT_PORT = VIEWER_PORT

/**
 * Start the viewer HTTP server. Resolves once listening. It serves `defaultName`
 * but every /api route may target another project via `?project=<name>`, so the
 * in-page project switcher works against the live server too.
 */
export async function runViewer (defaultName: string, port: number = DEFAULT_PORT): Promise<void> {
  const htmlPath = viewerHtmlPath()
  const ctxCache = new Map<string, ProjectCtx>()
  const ctxFor   = async (name: string): Promise<ProjectCtx> => {
    let c = ctxCache.get(name)
    if (!c) {
      c = await resolveCtx(name)
      ctxCache.set(name, c)
    }
    return c
  }
  await ctxFor(defaultName) // validate up front

  const server = createServer((req, res) => {
    const url      = new URL(req.url ?? '/', 'http://localhost')
    const sendJson = (obj: unknown, code = 200) => {
      res.writeHead(code, {
        'Content-Type':                'application/json',
        'Cache-Control':               'no-store',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify(obj))
    }

    // eslint-disable-next-line complexity -- request handler dispatches several /api routes
    void (async () => {
      try {
        const path  = url.pathname
        const pname = url.searchParams.get('project') || defaultName
        if (path === '/' || path === '/index.html') {
          const body = await readFile(htmlPath)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(body)
        }
        else if (path === '/api/projects')
          sendJson({ projects: await listProjects(), active: defaultName })
        else if (path === '/api/status')
          sendJson(await buildStatus(await ctxFor(pname)))
        else if (path === '/api/inventory') {
          const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200') || 200))
          const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0)
          sendJson(await buildInventory(await ctxFor(pname), limit, offset))
        }
        else if (path === '/api/doc') {
          const doc = await buildDoc(await ctxFor(pname), url.searchParams.get('id') ?? '')
          if (doc)
            sendJson(doc)
          else
            sendJson({ error: 'not found' }, 404)
        }
        else if (path === '/api/node') {
          const node = await buildNode(await ctxFor(pname), url.searchParams.get('id') ?? '')
          if (node)
            sendJson(node)
          else
            sendJson({ error: 'not found' }, 404)
        }
        else if (path === '/api/graph') {
          const n = Math.min(1200, Math.max(50, Number(url.searchParams.get('n') ?? '400') || 400))
          const k = Math.min(6, Math.max(1, Number(url.searchParams.get('k') ?? '3') || 3))
          sendJson(await buildGraph(await ctxFor(pname), n, k))
        }
        else if (path === '/api/search') {
          const query = (url.searchParams.get('q') ?? '').trim()
          if (!query)
            sendJson({ error: 'empty query' }, 400)
          else
            sendJson(await runSearch(await ctxFor(pname), query))
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
      console.log(`synapse viewer (${defaultName})  ->  http://localhost:${port}`)
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
