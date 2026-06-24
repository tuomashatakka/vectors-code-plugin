/**
 * Project registry + cwd auto-resolution. Projects live in the `project` table;
 * their ingest sources live in the `project.sources` jsonb column (the old
 * per-project config.json). Resolution order mirrors the Python plugin:
 *   $VINDEX_PROJECT  ->  nearest ancestor matching a project.root_path
 *                    ->  nearest ancestor with a .vindex/.git marker (basename)
 *                    ->  $VINDEX_DEFAULT
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { q, q1 } from './pool.ts'
import { ensureSpace } from './schema.ts'
import {
  DEFAULT_CHUNK_CONFIG


} from './types.ts'
import type { ChunkConfig, ProjectRow, SourceConfig } from './types.ts'
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  VINDEX_PROJECT,
  VINDEX_DEFAULT,
} from '../config.ts'


interface RawProject extends Omit<ProjectRow, 'chunk_cfg'> {
  chunk_cfg: ChunkConfig;
  sources:   SourceConfig[];
}

const SELECT_COLS =
  'id, name, parent_id, root_path, embed_model, rerank_model, space_id, chunk_cfg, sources'

/** Ancestor directories of `start`, nearest first, up to the filesystem root. */
function ancestors (start: string): string[] {
  const out: string[] = []
  let dir = resolve(start)
  for (let i = 0; i < 64; i++) {
    out.push(dir)

    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }
  return out
}

/** Resolve the active project name for a working directory. */
export async function resolveProjectName (cwd: string = process.cwd()): Promise<string> {
  if (VINDEX_PROJECT)
    return VINDEX_PROJECT

  const dirs = ancestors(cwd)
  // 1. A project explicitly anchored to one of these directories.
  const rows = await q<{ name: string; root_path: string }>(
    'SELECT name, root_path FROM project WHERE root_path = ANY($1)',
    [ dirs ],
  )
  if (rows.length) {
    const byDir = new Map(rows.map(r => [ r.root_path, r.name ]))
    for (const d of dirs)
      if (byDir.has(d))
        return byDir.get(d)!
  }
  // 2. Nearest ancestor carrying a project marker -> implied name.
  for (const d of dirs)
    if (existsSync(join(d, '.vindex')) || existsSync(join(d, '.git')))
      return basename(d) || VINDEX_DEFAULT
  // 3. Fallback.
  return VINDEX_DEFAULT
}

export async function getProject (name: string): Promise<RawProject | null> {
  return q1<RawProject>(`SELECT ${SELECT_COLS} FROM project WHERE name = $1`, [ name ])
}

export interface CreateProjectOpts {
  root?:         string | null;
  embed_model?:  string;
  rerank_model?: string;
  chunk?:        Partial<ChunkConfig>;
  parent?:       string | null;
}

/** Create the project if absent (idempotent); returns the row. */
export async function getOrCreateProject (
  name: string,
  opts: CreateProjectOpts = {},
): Promise<RawProject> {
  const existing = await getProject(name)
  if (existing)
    return existing

  const embed_model            = opts.embed_model || DEFAULT_EMBED_MODEL
  const rerank_model           = opts.rerank_model || DEFAULT_RERANK_MODEL
  const space                  = await ensureSpace(embed_model)
  const chunk_cfg: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...opts.chunk ?? {}}
  let parent_id: string | null = null
  if (opts.parent) {
    const p = await getProject(opts.parent)
    parent_id = p?.id ?? null
  }

  await q(
    `INSERT INTO project (name, parent_id, root_path, embed_model, rerank_model, space_id, chunk_cfg)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (name) DO NOTHING`,
    [ name, parent_id, opts.root ?? null, embed_model, rerank_model, space.id, JSON.stringify(chunk_cfg) ],
  )
  return (await getProject(name))!
}

/** Append (or replace by id) a source on a project. */
export async function addSource (name: string, source: SourceConfig): Promise<void> {
  const proj    = await getOrCreateProject(name)
  const sources = proj.sources.filter(s => s.id !== source.id)
  sources.push(source)
  await q('UPDATE project SET sources = $2 WHERE id = $1', [ proj.id, JSON.stringify(sources) ])
}

export async function getSources (name: string): Promise<SourceConfig[]> {
  const proj = await getProject(name)
  return proj?.sources ?? []
}

export interface ProjectSummary {
  name:      string;
  documents: number;
  chunks:    number;
  embedded:  number;
}

/** List projects with document/chunk counts (for `vindex projects` / status). */
export async function listProjects (): Promise<ProjectSummary[]> {
  return q<ProjectSummary>(`
    SELECT p.name,
           count(DISTINCT d.id)::int AS documents,
           count(c.id)::int          AS chunks,
           count(c.embedding_id)::int AS embedded
    FROM project p
    LEFT JOIN document d ON d.project_id = p.id
    LEFT JOIN chunk c    ON c.project_id = p.id
    GROUP BY p.name
    ORDER BY p.name
  `)
}
