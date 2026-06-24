/**
 * SOURCE FEEDER — periodically re-ingest every project's configured sources.
 * ingestProject already diffs by content hash and skips unchanged files, so this
 * is just a scheduled sweep. Changed chunks auto-enqueue embed jobs via the DDL
 * trigger (the worker fills their vectors).
 */
import { q } from '../../db/pool.ts'
import { listProjects } from '../../db/projects.ts'
import { ingestProject } from '../../db/ingest.ts'
import { SOURCE_INTERVAL } from '../../config.ts'

/** One sweep over all projects. Returns total chunks (re)written. */
export async function syncOnce (): Promise<number> {
  let total = 0
  for (const p of await listProjects())
    try {
      const stats = await ingestProject(p.name)
      total += stats.chunks
      if (stats.filesChanged)
        console.error(`[source-feeder] ${p.name}: ${stats.filesChanged} changed, ${stats.chunks} chunks`)
      await q(
        `INSERT INTO daemon_state (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [ `source:${p.name}`, JSON.stringify({ lastScan: new Date().toISOString() }) ],
      )
    }
    catch (err) {
      console.error(`[source-feeder] ${p.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  return total
}

export async function runSourceFeeder (signal: AbortSignal): Promise<void> {
  const interval = SOURCE_INTERVAL * 1000
  while (!signal.aborted) {
    try {
      await syncOnce()
    }
    catch (err) {
      console.error(`[source-feeder] ${err instanceof Error ? err.message : String(err)}`)
    }
    await new Promise(r => setTimeout(r, interval))
  }
}
