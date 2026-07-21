/**
 * Digest job worker — drains the digest_job queue. Each new chunk/message/
 * reference auto-enqueues an `embed` job (DDL trigger + 'digest' NOTIFY); this
 * worker claims jobs with FOR UPDATE SKIP LOCKED, embeds the referenced row, and
 * fills its embedding_id. Ollama-backed tasks (summarize/extract_*) are routed to
 * a local Ollama generate call; unknown tasks are marked done with a note.
 */
import { getPool, q1, toVector, tx } from '../db/pool.ts'
import { embed } from '../embed/embedder.ts'
import { OLLAMA_URL, OLLAMA_MODEL } from '../config.ts'


interface Job {
  id:      string;
  task:    string;
  payload: { node_kind?: string; id?: string; [k: string]: unknown };
}

const NODE_TABLE: Record<string, string> = {
  chunk:     'chunk',
  message:   'message',
  reference: 'reference',
}

async function spaceTableFor (spaceId: string): Promise<string> {
  const row = await q1<{ table_name: string }>(
    'SELECT table_name FROM embedding_space WHERE id=$1',
    [ spaceId ],
  )
  return row!.table_name
}

/** Embed one chunk/message/reference and fill its embedding_id. */
async function doEmbed (payload: Job['payload']): Promise<void> {
  const kind  = payload.node_kind ?? 'chunk'
  const id    = payload.id as string
  const table = NODE_TABLE[kind]
  if (!table)
    return

  const row = await q1<{ text: string; space_id: string | null; content_hash: Buffer }>(
    `SELECT ${kind === 'reference' ? "coalesce(title,'') || ' ' || coalesce(snippet,'')" : 'text'} AS text,
            space_id, content_hash
     FROM ${table} WHERE id=$1 AND embedding_id IS NULL`,
    [ id ],
  )
  if (!row || !row.text?.trim())
    return

  // Reference rows may lack a space; default to the single MiniLM space.
  let spaceId = row.space_id
  if (!spaceId) {
    const def = await q1<{ id: string }>('SELECT id FROM embedding_space ORDER BY created_at LIMIT 1')
    spaceId = def!.id
  }

  const embTable = await spaceTableFor(spaceId)
  const [ vec ]  = await embed([ row.text ])

  await tx(async c => {
    const emb = await c.query(
      `INSERT INTO ${embTable} (space_id, content_hash, embedding)
       VALUES ($1,$2,$3::vector)
       ON CONFLICT (space_id, content_hash) DO UPDATE SET space_id=EXCLUDED.space_id
       RETURNING embedding_id`,
      [ spaceId, row.content_hash, toVector(vec) ],
    )
    await c.query(`UPDATE ${table} SET embedding_id=$1, space_id=$2 WHERE id=$3`, [
      emb.rows[0].embedding_id, spaceId, id,
    ])
  })
}

/** Best-effort local-Ollama text task (summaries, fact extraction). */
async function ollamaGenerate (prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
  })
  if (!res.ok)
    throw new Error(`ollama ${res.status}`)

  const data = (await res.json()) as { response?: string }
  return data.response ?? ''
}

/** Claim and process a single job. Returns false when the queue is empty. */
export async function processOne (): Promise<boolean> {
  const claimed = await q1<Job>(`
    UPDATE digest_job SET state='leased', attempts=attempts+1,
           lease_until = now() + interval '5 min', updated_at = now()
    WHERE id = (
      SELECT id FROM digest_job
      WHERE state='queued'
      ORDER BY priority, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING id, task, payload`)
  if (!claimed)
    return false

  try {
    if (claimed.task === 'embed')
      await doEmbed(claimed.payload); else if (claimed.task === 'summarize' || claimed.task.startsWith('extract'))
      try {
        await ollamaGenerate(`Task: ${claimed.task}\nPayload: ${JSON.stringify(claimed.payload)}`)
      }
      catch { /* Ollama optional */ }
    await getPool().query(
      "UPDATE digest_job SET state='done', updated_at=now(), result=$2 WHERE id=$1",
      [ claimed.id, JSON.stringify({ ok: true }) ],
    )
  }
  catch (err) {
    await getPool().query(
      `UPDATE digest_job
       SET state = CASE WHEN attempts >= max_attempts THEN 'dead'::job_state ELSE 'queued'::job_state END,
           last_error=$2, updated_at=now()
       WHERE id=$1`,
      [ claimed.id, String(err instanceof Error ? err.message : String(err)) ],
    )
  }
  return true
}

/** Run the worker until aborted: LISTEN 'digest' for low latency + poll fallback. */
export async function runWorker (signal: AbortSignal): Promise<void> {
  const client = await getPool().connect()
  let wake: (() => void) | null = null
  client.on('error', err => {
    // A dropped LISTEN connection should not crash the whole daemon.
    console.error('[pg] listen client error:', err.message)
  })
  client.on('notification', () => wake?.())
  await client.query('LISTEN digest')

  try {
    while (!signal.aborted) {
      let drained = false
      while (!signal.aborted && await processOne())
        drained = true
      // Wait for a NOTIFY or a 2s poll tick.
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, drained ? 200 : 2000)
        wake = () => {
          clearTimeout(t); resolve()
        }
      })
      wake = null
    }
  }
  finally {
    client.removeAllListeners('notification')
    client.release()
  }
}
