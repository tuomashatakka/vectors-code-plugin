/**
 * Ingestion pipeline: walk a project's sources, diff by whole-file content hash,
 * chunk changed files, embed each chunk, and UPSERT documents + chunks + vectors
 * into Postgres. Unchanged files are skipped. Vectors are deduplicated within an
 * embedding space by content hash (UNIQUE (space_id, content_hash)).
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { q, q1, tx, toVector } from './pool.ts'
import { getOrCreateProject, getSources } from './projects.ts'
import { chunkFile } from '../chunk/chunker.ts'
import { embed } from '../embed/embedder.ts'
import { assertWritable, assertAllowedRoot } from '../guards.ts'
import type { SourceConfig } from './types.ts'


function sha256 (text: string): Buffer {
  return createHash('sha256').update(text, 'utf8')
    .digest()
}

function approxTokens (text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

/** List files under a source root matching its globs. Uses Bun.Glob. */
async function listFiles (source: SourceConfig): Promise<string[]> {
  const globs = source.globs?.length ? source.globs : [ '**/*' ]
  const found = new Set<string>()
  const Glob  = typeof Bun !== 'undefined' ? Bun.Glob : undefined
  if (Glob)
    for (const pattern of globs)
      for await (const rel of new Glob(pattern).scan({ cwd: source.path, onlyFiles: true }))
        found.add(rel as string); else {
    const { glob } = await import('node:fs/promises')
    for (const pattern of globs)
      for await (const abs of glob(join(source.path, pattern)))
        found.add(relative(source.path, abs as string))
  }
  return [ ...found ].sort()
}

/** Build a public URL for a file from the source's base_url template. */
function buildUrl (source: SourceConfig, relPath: string): string | null {
  if (!source.base_url)
    return null
  return source.base_url.includes('{path}')
    ? source.base_url.replace('{path}', relPath)
    : source.base_url.replace(/\/$/, '') + '/' + relPath
}

export interface IngestStats {
  project:      string;
  filesScanned: number;
  filesChanged: number;
  chunks:       number;
}

/** Ingest one project's sources. Pass rebuild=true to wipe documents first. */
export async function ingestProject (name: string, rebuild = false): Promise<IngestStats> {
  assertWritable('ingest')

  const proj  = await getOrCreateProject(name)
  const space = await q1<{ table_name: string }>(
    'SELECT table_name FROM embedding_space WHERE id = $1',
    [ proj.space_id ],
  )
  const embTable = space!.table_name

  if (rebuild)
    await q('DELETE FROM document WHERE project_id = $1', [ proj.id ])

  const sources            = await getSources(name)
  const stats: IngestStats = { project: name, filesScanned: 0, filesChanged: 0, chunks: 0 }

  for (const source of sources) {
    assertAllowedRoot(source.path)

    const files = await listFiles(source)
    for (const rel of files) {
      stats.filesScanned++

      const abs = join(source.path, rel)
      let text: string
      let mtime: Date | null = null
      try {
        text = await readFile(abs, 'utf8')
        mtime = (await stat(abs)).mtime
      }
      catch {
        continue // unreadable / binary — skip
      }

      const fileHash = sha256(text)

      // Skip unchanged files.
      const existing = await q1<{ id: string; content_hash: Buffer }>(
        'SELECT id, content_hash FROM document WHERE project_id=$1 AND source_id=$2 AND rel_path=$3',
        [ proj.id, source.id, rel ],
      )
      if (existing && Buffer.compare(existing.content_hash, fileHash) === 0)
        continue

      stats.filesChanged++

      const url      = buildUrl(source, rel)
      const title    = rel
      const produced = chunkFile(rel, text, proj.chunk_cfg)
      if (produced.length === 0)
        continue

      // Embed all chunks for this file in one batch.
      const vectors = await embed(produced.map(c => c.text), proj.embed_model)

      await tx(async client => {
        const doc = await client.query(
          `INSERT INTO document (project_id, source_id, rel_path, title, url, content, content_hash, mtime)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (project_id, source_id, rel_path)
           DO UPDATE SET title=EXCLUDED.title, url=EXCLUDED.url, content=EXCLUDED.content,
                         content_hash=EXCLUDED.content_hash, mtime=EXCLUDED.mtime
           RETURNING id`,
          [ proj.id, source.id, rel, title, url, text, fileHash, mtime ],
        )
        const documentId = doc.rows[0].id as string
        await client.query('DELETE FROM chunk WHERE document_id = $1', [ documentId ])

        for (let i = 0; i < produced.length; i++) {
          const c         = produced[i]
          const chunkHash = sha256(c.text)
          const emb       = await client.query(
            `INSERT INTO ${embTable} (space_id, content_hash, token_count, embedding)
             VALUES ($1,$2,$3,$4::vector)
             ON CONFLICT (space_id, content_hash) DO UPDATE SET token_count = EXCLUDED.token_count
             RETURNING embedding_id`,
            [ proj.space_id, chunkHash, approxTokens(c.text), toVector(vectors[i]) ],
          )
          await client.query(
            `INSERT INTO chunk (document_id, project_id, ordinal, title, text, url, content_hash, token_count, space_id, embedding_id, unit_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (document_id, ordinal)
             DO UPDATE SET text=EXCLUDED.text, title=EXCLUDED.title, url=EXCLUDED.url,
                           content_hash=EXCLUDED.content_hash, embedding_id=EXCLUDED.embedding_id,
                           unit_type=EXCLUDED.unit_type`,
            [ documentId, proj.id, c.ordinal, c.title, c.text, c.url ?? url, chunkHash,
              approxTokens(c.text), proj.space_id, emb.rows[0].embedding_id, c.unit_type ],
          )
          stats.chunks++
        }
      })
    }
  }
  return stats
}

/** Wipe + rebuild a project from scratch. */
export async function reindexProject (name: string): Promise<IngestStats> {
  return ingestProject(name, true)
}
