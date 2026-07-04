/**
 * 3D synapse viewer server (TypeScript port of viewer_server.py).
 *
 * Serves assets/viewer.html plus a tiny JSON API over a project's vector index:
 *   GET /                       the viewer page
 *   GET /api/status             live index status (name, documents, chunks, ...)
 *   GET /api/inventory          data inventory: sources + paginated documents + global projects
 *   GET /api/doc?id=...         one document's chunk listing (add &full=1 for the
 *                               whole file content + aggregated references)
 *   GET /api/node?id=...        full chunk detail: text, references, siblings, PCA relations
 *   GET /api/graph?n=400&k=3    sampled chunks + knn synapse links; positions
 *                               are a PCA(3) projection of the real embeddings
 *   GET /api/search?q=...       reranked search; hits carry a graph_index when
 *                               already sampled, else PCA coords + attach links
 *   GET /api/events             server-sent events tailing the Postgres
 *                               `vindex_events` channel (live searches/ingests)
 *
 * Every /api route accepts `?project=<name>`; the special name `*` switches to
 * the all-projects scope: the graph becomes one PCA cluster per project (see
 * graph.ts), search fans out globally, and node/doc lookups resolve their
 * owning project automatically.
 *
 * Built on node:http (runs under Bun). PCA via the ml-pca package.
 */
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { VIEWER_PORT } from '../config.ts'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getPool, q, q1 } from '../db/pool.ts'
import { EVENT_CHANNEL } from '../db/notify.ts'
import { getSources, listProjects } from '../db/projects.ts'
import { searchGlobal, searchProject } from '../search/search.ts'
import { buildGraph, buildGraphAll, dot, graphState, parseVector, projectVec, resolveCtx, round4 } from './graph.ts'
import type { ProjectCtx } from './graph.ts'
import type { SourceConfig } from '../db/types.ts'
import type { ProjectSummary } from '../db/projects.ts'


export { buildGraph, buildGraphAll, resolveCtx } from './graph.ts'
export type { GraphResult, ProjectCtx } from './graph.ts'


const HERE = dirname(fileURLToPath(import.meta.url))

/** The pseudo project name selecting the all-projects scope. */
export const ALL_SCOPE = '*'

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

interface SearchEntry {
  id:            string;
  title:         string | null;
  source:        string;
  url:           string | null;
  chunk:         number;
  unit_type:     string | null;
  project:       string;
  score:         number;
  rerank_score?: number;
  signals?:      string[];
  graph_index?:  number;
  p?:            [number, number, number];
  attach?:       [number, number][];
}

interface SearchResponse {
  query:   string;
  project: string;
  results: SearchEntry[];
}

// Run search (single project or global) and shape hits for the viewer: splice
//  into the sampled graph when already present, else carry PCA coords + nearest
//  attach links within the hit's own project cluster.
async function runSearch (
  pname: string,
  ctxFor: (name: string) => Promise<ProjectCtx>,
  query: string,
): Promise<SearchResponse> {
  const res = pname === ALL_SCOPE
    ? await searchGlobal(query, { topk: 10 })
    : await searchProject(query, pname, { topk: 8 })

  // Fetch embeddings for hits not already in the sampled graph so we can place
  //  them — grouped by owning project, since each has its own embedding table.
  const missingByProject = new Map<string, string[]>()
  for (const h of res.hits)
    if (!graphState.idToIdx.has(h.chunk_id)) {
      const list = missingByProject.get(h.project) ?? []
      list.push(h.chunk_id)
      missingByProject.set(h.project, list)
    }

  const vecById = new Map<string, number[]>()
  for (const [ project, ids ] of missingByProject)
    try {
      const ctx  = await ctxFor(project)
      const rows = await q<{ id: string; embedding: string }>(
        `SELECT c.id, e.embedding
         FROM chunk c JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
         WHERE c.id = ANY($1)`,
        [ ids ],
      )
      for (const r of rows)
        vecById.set(r.id, parseVector(r.embedding))
    }
    catch {

      /* project vanished mid-flight — hits are still listed, just unplaced */
    }

  const results: SearchEntry[] = res.hits.map(h => {
    const entry: SearchEntry = {
      id:        h.chunk_id,
      title:     h.title,
      source:    h.title ?? '',
      url:       h.url,
      chunk:     h.ordinal,
      unit_type: h.unit_type,
      project:   h.project,
      score:     h.score,
      signals:   [ h.dense > 0 ? 'dense' : '', h.sparse > 0 ? 'sparse' : '' ].filter(Boolean),
    }
    if (h.rerank != null)
      entry.rerank_score = h.rerank

    const gi = graphState.idToIdx.get(h.chunk_id)
    if (gi != null)
      entry.graph_index = gi; else {
      const vec = vecById.get(h.chunk_id)
      const st  = graphState.projects.get(h.project)
      if (vec && st) {
        entry.p = projectVec(st, vec)
        if (st.vecs.length) {
          const sims = st.vecs.map((gv, i) => [ dot(gv, vec), st.gidx[i]! ] as [number, number])
          sims.sort((a, b) => b[0] - a[0])
          entry.attach = sims.slice(0, 3).map(([ s, i ]) => [ i, round4(s) ])
        }
      }
    }
    return entry
  })

  return { query, project: res.project, results }
}

interface StatusResult {
  name:        string;
  doc_count:   number;
  documents:   number;
  chunks:      number;
  embedded:    number;
  embed_model: string;
  state:       string;
  projects?:   number;
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

/** Aggregate status across every project (the `*` scope). */
export async function buildStatusAll (): Promise<StatusResult> {
  const projects = await listProjects()
  const models   = await q<{ embed_model: string }>('SELECT DISTINCT embed_model FROM project ORDER BY embed_model')
  const chunks   = projects.reduce((s, p) => s + p.chunks, 0)
  const embedded = projects.reduce((s, p) => s + p.embedded, 0)
  return {
    name:        'all projects',
    doc_count:   chunks,
    documents:   projects.reduce((s, p) => s + p.documents, 0),
    chunks,
    embedded,
    embed_model: models.map(m => m.embed_model).join(' · ') || '—',
    state:       embedded >= chunks ? 'ready' : `embedding ${embedded}/${chunks}`,
    projects:    projects.length,
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
  project?:  string;
}

type InventorySource = SourceConfig & { project?: string }

interface InventoryResult {
  project: {
    name:        string;
    embed_model: string;
    documents:   number;
    chunks:      number;
    embedded:    number;
    state:       string;
    sources:     InventorySource[];
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

/** Inventory for the `*` scope: every project's sources + documents, merged. */
export async function buildInventoryAll (limit: number, offset: number): Promise<InventoryResult> {
  const status                     = await buildStatusAll()
  const global                     = await listProjects()
  const sources: InventorySource[] = []
  for (const p of global)
    for (const s of await getSources(p.name))
      sources.push({ ...s, project: p.name })

  const docs = await q<InventoryDoc>(
    `SELECT d.id, d.source_id, d.rel_path, d.title, d.url, d.mtime, p.name AS project,
            (SELECT count(*) FROM chunk c WHERE c.document_id = d.id)::int AS chunks
     FROM document d JOIN project p ON p.id = d.project_id
     ORDER BY p.name, d.source_id, d.rel_path
     LIMIT $1 OFFSET $2`,
    [ limit, offset ],
  )
  return {
    project: {
      name:        'all projects',
      embed_model: status.embed_model,
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
    global,
  }
}

interface DocChunk {
  id:          string;
  ordinal:     number;
  title:       string | null;
  unit_type:   string | null;
  token_count: number | null;
  embedded:    boolean;
}

interface DocResult {
  id:          string;
  rel_path:    string | null;
  title:       string | null;
  project?:    string;
  content?:    string;
  references?: { kind: string; uri: string }[];
  chunks:      DocChunk[];
}

/**
 * One document's chunk listing — the drill-down leaf of the inventory tree.
 * With `full`, the whole stored file content plus the union of the chunks'
 * references is included, so the viewer can show the document in full.
 */
export async function buildDoc (ctx: ProjectCtx, id: string, full = false): Promise<DocResult | null> {
  if (!UUID_RE.test(id))
    return null

  const doc = await q1<{ id: string; rel_path: string | null; title: string | null; content: string | null }>(
    `SELECT id, rel_path, title${full ? ', content' : ', NULL AS content'}
     FROM document WHERE id = $1 AND project_id = $2`,
    [ id, ctx.id ],
  )
  if (!doc)
    return null

  const chunks = await q<DocChunk>(
    `SELECT id, ordinal, title, unit_type, token_count,
            (embedding_id IS NOT NULL) AS embedded
     FROM chunk WHERE document_id = $1 ORDER BY ordinal`,
    [ id ],
  )
  const out: DocResult = { id: doc.id, rel_path: doc.rel_path, title: doc.title, project: ctx.name, chunks }
  if (full) {
    out.content    = doc.content ?? ''
    out.references = await q<{ kind: string; uri: string }>(
      `SELECT DISTINCT r.kind, r.uri
       FROM link l
       JOIN reference r ON r.id = l.dst_id
       JOIN chunk c ON c.id = l.src_id
       WHERE l.src_kind = 'chunk' AND l.dst_kind = 'reference' AND c.document_id = $1`,
      [ id ],
    )
  }
  return out
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

interface NodeSibling {
  id:           string;
  title:        string | null;
  chunk:        number;
  unit_type:    string | null;
  self?:        boolean;
  graph_index?: number;
}

interface NodeResult {
  id:          string;
  title:       string | null;
  source:      string;
  source_id:   string;
  chunk:       number;
  unit_type:   string | null;
  url:         string | null;
  project:     string;
  document_id: string;
  text:        string;
  symbol:      string | null;
  char_count:  number;
  references:  { kind: string; uri: string }[];
  relations:   NodeRelation[];
  document:    NodeSibling[];
}

interface NodeRow {
  id:          string;
  title:       string | null;
  text:        string | null;
  url:         string | null;
  ordinal:     number | null;
  unit_type:   string | null;
  symbol:      string | null;
  document_id: string;
  rel_path:    string | null;
  source_id:   string | null;
}

/** Full node detail for the viewer panel: chunk text, references, siblings, PCA relations. */
export async function buildNode (ctx: ProjectCtx, id: string): Promise<NodeResult | null> {
  if (!UUID_RE.test(id))
    return null

  const row = await q1<NodeRow>(
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
    const entry: NodeSibling = {
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
    id:          row.id,
    title:       row.title,
    source:      row.rel_path ?? '',
    source_id:   row.source_id ?? '',
    chunk:       row.ordinal ?? 0,
    unit_type:   row.unit_type,
    url:         row.url,
    project:     ctx.name,
    document_id: row.document_id,
    text:        row.text ?? '',
    symbol:      row.symbol,
    char_count:  (row.text ?? '').length,
    references,
    relations,
    document,
  }
}

/** Fetch one chunk's embedding vector from its project's embedding table. */
async function chunkVec (ctx: ProjectCtx, id: string): Promise<number[] | null> {
  const emb = await q1<{ embedding: string }>(
    `SELECT e.embedding FROM chunk c
     JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
     WHERE c.id = $1`,
    [ id ],
  )
  return emb ? parseVector(emb.embedding) : null
}

/** Top cosine neighbours of a chunk within its project's sampled cluster. */
async function nodeRelations (ctx: ProjectCtx, id: string): Promise<NodeRelation[]> {
  const st = graphState.projects.get(ctx.name)
  if (!st || !st.vecs.length)
    return []

  const gi       = graphState.idToIdx.get(id)
  const localIdx = gi != null ? st.gidx.indexOf(gi) : -1
  const vec      = localIdx >= 0 ? st.vecs[localIdx]! : await chunkVec(ctx, id)
  if (!vec)
    return []

  const sims = st.vecs.map((gv, i) => [ dot(gv, vec), st.gidx[i]! ] as [number, number])
    .filter(([ , g ]) => g !== gi)
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
      score:       round4(s),
      graph_index: i,
    })
  }
  return out
}

/** Resolve which project owns a chunk (for node lookups in the `*` scope). */
async function projectOfChunk (id: string): Promise<string | null> {
  if (!UUID_RE.test(id))
    return null

  const row = await q1<{ name: string }>(
    'SELECT p.name FROM chunk c JOIN project p ON p.id = c.project_id WHERE c.id = $1',
    [ id ],
  )
  return row?.name ?? null
}

/** Resolve which project owns a document (for doc lookups in the `*` scope). */
async function projectOfDoc (id: string): Promise<string | null> {
  if (!UUID_RE.test(id))
    return null

  const row = await q1<{ name: string }>(
    'SELECT p.name FROM document d JOIN project p ON p.id = d.project_id WHERE d.id = $1',
    [ id ],
  )
  return row?.name ?? null
}

/** Small helper: run an owner-resolver, returning null instead of throwing. */
async function ownerOrNull (
  id: string,
  resolver: (id: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    return await resolver(id)
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Live events: LISTEN on the vindex_events channel with one dedicated pooled
//  client, fan the payloads out to every connected SSE response verbatim.
const sseClients = new Set<ServerResponse>()

let listenerUp = false

async function ensureEventListener (): Promise<void> {
  if (listenerUp)
    return
  listenerUp = true

  try {
    const client = await getPool().connect()
    await client.query(`LISTEN ${EVENT_CHANNEL}`)
    client.on('notification', msg => {
      const frame = `data: ${msg.payload ?? '{}'}\n\n`
      for (const res of sseClients)
        res.write(frame)
    })
    client.on('error', () => {
      listenerUp = false // next /api/events subscriber re-establishes the LISTEN
    })
  }
  catch (err) {
    listenerUp = false
    throw err
  }

  // Keep intermediaries from timing out idle streams.
  const heartbeat = setInterval(() => {
    for (const res of sseClients)
      res.write(': ping\n\n')
  }, 25000)
  heartbeat.unref()
}

const DEFAULT_PORT = VIEWER_PORT

/**
 * Start the viewer HTTP server. Resolves once listening. It serves `defaultName`
 * but every /api route may target another project via `?project=<name>` — or the
 * whole store via `?project=*` — so the in-page project switcher works against
 * the live server too.
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
  if (defaultName !== ALL_SCOPE)
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
        const isAll = pname === ALL_SCOPE
        if (path === '/' || path === '/index.html') {
          const body = await readFile(htmlPath)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(body)
        }
        else if (path === '/api/projects')
          sendJson({ projects: await listProjects(), active: defaultName })
        else if (path === '/api/status')
          sendJson(isAll ? await buildStatusAll() : await buildStatus(await ctxFor(pname)))
        else if (path === '/api/inventory') {
          const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200') || 200))
          const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0)
          sendJson(isAll ? await buildInventoryAll(limit, offset) : await buildInventory(await ctxFor(pname), limit, offset))
        }
        else if (path === '/api/doc') {
          const id    = url.searchParams.get('id') ?? ''
          const full  = url.searchParams.get('full') === '1'
          const owner = isAll ? await ownerOrNull(id, projectOfDoc) : pname
          const doc   = owner ? await buildDoc(await ctxFor(owner), id, full) : null
          if (doc)
            sendJson(doc)
          else
            sendJson({ error: 'not found' }, 404)
        }
        else if (path === '/api/node') {
          const id    = url.searchParams.get('id') ?? ''
          const owner = isAll ? await ownerOrNull(id, projectOfChunk) : pname
          const node  = owner ? await buildNode(await ctxFor(owner), id) : null
          if (node)
            sendJson(node)
          else
            sendJson({ error: 'not found' }, 404)
        }
        else if (path === '/api/graph') {
          const n = Math.min(1200, Math.max(50, Number(url.searchParams.get('n') ?? '400') || 400))
          const k = Math.min(6, Math.max(1, Number(url.searchParams.get('k') ?? '3') || 3))
          sendJson(isAll ? await buildGraphAll(n, k) : await buildGraph(await ctxFor(pname), n, k))
        }
        else if (path === '/api/search') {
          const query = (url.searchParams.get('q') ?? '').trim()
          if (!query)
            sendJson({ error: 'empty query' }, 400)
          else
            sendJson(await runSearch(pname, ctxFor, query))
        }
        else if (path === '/api/events') {
          await ensureEventListener()
          res.writeHead(200, {
            'Content-Type':                'text/event-stream',
            'Cache-Control':               'no-store',
            'Connection':                  'keep-alive',
            'Access-Control-Allow-Origin': '*',
          })
          res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`)
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
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
