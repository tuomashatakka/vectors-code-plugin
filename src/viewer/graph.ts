/**
 * Graph math for the 3D synapse viewer: chunk sampling, PCA(3) projection,
 * knn synapse links, and the retained per-project projection state that lets
 * later search hits / node relations land in the same 3D space the graph was
 * laid out in. Projects may use different embedding models (and so different
 * vector dimensions), which is why every piece of state is per project — the
 * all-projects scope is one PCA cluster per project on a golden-angle spiral.
 */
import { PCA } from 'ml-pca'
import { q, q1 } from '../db/pool.ts'
import { getProject, listProjects } from '../db/projects.ts'


export interface ProjectCtx {
  id:         string;
  name:       string;
  embedModel: string;
  embTable:   string;
}

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

export interface GraphNode {
  id:          string;
  title:       string;
  source:      string;
  source_id:   string;
  document_id: string;
  url:         string | null;
  chunk:       number;
  unit_type:   string;
  project:     string;
  snippet:     string;
  p:           [number, number, number];
}

/** One project's fitted PCA + placement, retained between /api calls. */
export interface ProjState {
  pca:    PCA | null;
  scale:  number;
  offset: [number, number, number];
  vecs:   number[][];
  gidx:   number[];
}

export interface GraphState {
  idToIdx:  Map<string, number>;
  projects: Map<string, ProjState>;
}

export const graphState: GraphState = { idToIdx: new Map(), projects: new Map() }

interface ChunkRow {
  id:          string;
  title:       string | null;
  text:        string | null;
  url:         string | null;
  unit_type:   string | null;
  ordinal:     number | null;
  document_id: string;
  source_id:   string | null;
  rel_path:    string | null;
  embedding:   string;
}

/** Sample up to n embedded chunks at random across the index. */
async function sampleChunks (ctx: ProjectCtx, n: number): Promise<ChunkRow[]> {
  return q<ChunkRow>(
    `SELECT c.id, c.title, c.text, c.url, c.unit_type, c.ordinal, c.document_id,
            d.source_id, d.rel_path, e.embedding
     FROM chunk c
     JOIN document d ON d.id = c.document_id
     JOIN ${ctx.embTable} e ON e.embedding_id = c.embedding_id
     WHERE c.project_id = $1 AND c.embedding_id IS NOT NULL
     ORDER BY random()
     LIMIT $2`,
    [ ctx.id, n ],
  )
}

/** Parse a pgvector text literal "[a,b,c]" into a number[]. */
export function parseVector (v: string | number[]): number[] {
  if (Array.isArray(v))
    return v as number[]
  return v.replace(/^\[|\]$/g, '').split(',')
    .map(Number)
}

export function dot (a: number[], b: number[]): number {
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

export const round4 = (x: number): number => Math.round(x * 1e4) / 1e4

export interface GraphResult {
  nodes:     GraphNode[];
  links:     [number, number, number][];
  k:         number;
  projects?: { name: string; center: [number, number, number]; count: number }[];
}

interface CloudProjection {
  pos:   [number, number, number][];
  pca:   PCA | null;
  scale: number;
}

/** PCA(3)-project one sampled cloud, normalised into a `radius`-sized ball. */
function projectCloud (vecs: number[][], radius: number): CloudProjection {
  // Too few samples for a meaningful SVD: place them on a tiny flat ring.
  if (vecs.length < 4) {
    const pos = vecs.map((_, i): [number, number, number] => [
      round4(Math.cos(i * 2.4) * 0.7),
      round4(Math.sin(i * 1.7) * 0.4),
      round4(Math.sin(i * 2.4) * 0.7),
    ])
    return { pos, pca: null, scale: 1 }
  }

  const pca  = new PCA(vecs, { method: 'SVD', center: true, scale: false })
  const proj = pca.predict(vecs, { nComponents: 3 }).to2DArray()

  let maxAbs = 1e-6
  for (const row of proj)
    for (const x of row)
      maxAbs = Math.max(maxAbs, Math.abs(x))

  const scale = radius / maxAbs
  const pos   = proj.map((row): [number, number, number] =>
    [ round4(row[0]! * scale), round4(row[1]! * scale), round4(row[2]! * scale) ])
  return { pos, pca, scale }
}

/** knn links (cosine) within one project's sampled vectors, in global indices. */
function knnLinks (vecs: number[][], gidx: number[], k: number): [number, number, number][] {
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
      const a   = Math.min(gidx[i]!, gidx[j]!)
      const b   = Math.max(gidx[i]!, gidx[j]!)
      const key = `${a}-${b}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push([ a, b, round4(sims[m]![0]) ])
      }
    }
  }
  return links
}

/** Golden-angle spiral layout for `count` cluster centers, slightly flattened. */
function sphereLayout (count: number, R: number): [number, number, number][] {
  if (count <= 1)
    return [[ 0, 0, 0 ]]

  const golden                          = Math.PI * (3 - Math.sqrt(5))
  const pts: [number, number, number][] = []
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * i / (count - 1)
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = golden * i
    pts.push([ round4(Math.cos(a) * r * R), round4(y * R * 0.55), round4(Math.sin(a) * r * R) ])
  }
  return pts
}

function toGraphNode (r: ChunkRow, project: string, p: [number, number, number]): GraphNode {
  return {
    id:          r.id,
    title:       r.title ?? '',
    source:      r.rel_path ?? r.title ?? '',
    source_id:   r.source_id ?? '',
    document_id: r.document_id,
    url:         r.url ?? null,
    chunk:       r.ordinal ?? 0,
    unit_type:   r.unit_type ?? '',
    project,
    snippet:     snippet(r.text),
    p,
  }
}

// Hierarchy bundling weights: how strongly a chunk is pulled toward its
//  document's / source's centroid. The residual PCA share keeps semantics.
const DOC_PULL = 0.42
const SRC_PULL = 0.16

/**
 * Pull each chunk toward its document + source centroids so the four-level
 * hierarchy (project → source → document → chunk) reads spatially: documents
 * clump, sources form neighbourhoods, and PCA still spreads the semantics.
 */
function bundleHierarchy (pos: [number, number, number][], rows: ChunkRow[]): void {
  const centroids = (key: (r: ChunkRow) => string): Map<string, [number, number, number]> => {
    const sums = new Map<string, [number, number, number, number]>()
    rows.forEach((r, i) => {
      const k = key(r)
      const s = sums.get(k) ?? [ 0, 0, 0, 0 ]
      s[0] += pos[i]![0]; s[1] += pos[i]![1]; s[2] += pos[i]![2]; s[3]++
      sums.set(k, s)
    })

    const out = new Map<string, [number, number, number]>()
    for (const [ k, s ] of sums)
      out.set(k, [ s[0] / s[3], s[1] / s[3], s[2] / s[3] ])
    return out
  }

  const byDoc = centroids(r => r.document_id)
  const bySrc = centroids(r => r.source_id ?? '')
  const rest  = 1 - DOC_PULL - SRC_PULL
  rows.forEach((r, i) => {
    const d = byDoc.get(r.document_id)!
    const s = bySrc.get(r.source_id ?? '')!
    for (let ax = 0; ax < 3; ax++)
      pos[i]![ax] = round4(pos[i]![ax]! * rest + d[ax]! * DOC_PULL + s[ax]! * SRC_PULL)
  })
}

// Build the sampled single-project graph: PCA(3) positions + knn synapse links.
export async function buildGraph (ctx: ProjectCtx, n: number, k: number): Promise<GraphResult> {
  graphState.idToIdx  = new Map()
  graphState.projects = new Map()

  const rows = await sampleChunks(ctx, n)
  const vecs = rows.map(r => parseVector(r.embedding))
  if (vecs.length === 0)
    return { nodes: [], links: [], k }

  const { pos, pca, scale } = projectCloud(vecs, 6.0)
  bundleHierarchy(pos, rows)

  const gidx  = rows.map((_, i) => i)
  const nodes = rows.map((r, i) => toGraphNode(r, ctx.name, pos[i]!))
  const links = knnLinks(vecs, gidx, k)

  graphState.idToIdx = new Map(rows.map((r, i) => [ r.id, i ]))
  graphState.projects.set(ctx.name, { pca, scale, offset: [ 0, 0, 0 ], vecs, gidx })

  return { nodes, links, k }
}

// Build the all-projects graph: one PCA cluster per project, cluster centers on
//  a golden-angle spiral. Cross-project links are impossible (different spaces),
//  so synapses stay within each project's cluster.
export async function buildGraphAll (n: number, k: number): Promise<GraphResult> {
  graphState.idToIdx  = new Map()
  graphState.projects = new Map()

  const summaries = (await listProjects()).filter(p => p.embedded > 0)
  if (summaries.length === 0)
    return { nodes: [], links: [], k, projects: []}

  const per     = Math.max(24, Math.floor(n / summaries.length))
  const radius  = 3.0
  const centers = sphereLayout(summaries.length, Math.max(7, radius * Math.sqrt(summaries.length) * 1.6))

  const nodes: GraphNode[]                = []
  const links: [number, number, number][] = []
  const projects: GraphResult['projects'] = []

  for (let pi = 0; pi < summaries.length; pi++) {
    const name = summaries[pi]!.name
    let ctx: ProjectCtx
    try {
      ctx = await resolveCtx(name)
    }
    catch {
      continue // missing space — skip the project, keep the rest of the scope
    }

    const rows = await sampleChunks(ctx, per)
    if (rows.length === 0)
      continue

    const vecs                = rows.map(r => parseVector(r.embedding))
    const { pos, pca, scale } = projectCloud(vecs, radius)
    bundleHierarchy(pos, rows)

    const offset         = centers[pi]!
    const gidx: number[] = []

    rows.forEach((r, i) => {
      const gi = nodes.length
      gidx.push(gi)
      graphState.idToIdx.set(r.id, gi)
      nodes.push(toGraphNode(r, name, [
        round4(pos[i]![0] + offset[0]),
        round4(pos[i]![1] + offset[1]),
        round4(pos[i]![2] + offset[2]),
      ]))
    })
    links.push(...knnLinks(vecs, gidx, k))
    graphState.projects.set(name, { pca, scale, offset, vecs, gidx })
    projects.push({ name, center: offset, count: rows.length })
  }

  return { nodes, links, k, projects }
}

/** Project a vector into one project's fitted PCA space (offset included). */
export function projectVec (st: ProjState, vec: number[]): [number, number, number] {
  if (!st.pca)
    return [ ...st.offset ]

  const row = st.pca.predict([ vec ], { nComponents: 3 }).to2DArray()[0]!
  return [
    round4(row[0]! * st.scale + st.offset[0]),
    round4(row[1]! * st.scale + st.offset[1]),
    round4(row[2]! * st.scale + st.offset[2]),
  ]
}
