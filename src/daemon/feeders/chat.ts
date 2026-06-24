/**
 * CHAT FEEDER — mirror Claude transcripts into session/message. Watches the
 * CHAT_GLOBS (~/.claude/projects/**\/*.jsonl), parses new lines past a per-file
 * watermark in daemon_state, and upserts them. New message rows auto-enqueue an
 * `embed` digest job via the DDL trigger.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { q, q1, tx } from '../../db/pool.ts'
import { parseTranscript } from '../../transcript.ts'
import { CHAT_GLOBS } from '../../config.ts'


function sha256 (t: string): Buffer {
  return createHash('sha256').update(t, 'utf8')
    .digest()
}

interface Watermark {
  sessionId: string;
  seq:       number;
}

async function getWatermark (key: string): Promise<Watermark | null> {
  const row = await q1<{ value: Watermark }>('SELECT value FROM daemon_state WHERE key=$1', [ key ])
  return row?.value ?? null
}

async function setWatermark (key: string, wm: Watermark): Promise<void> {
  await q(
    `INSERT INTO daemon_state (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [ key, JSON.stringify(wm) ],
  )
}

async function listFiles (): Promise<string[]> {
  const { glob } = await import('node:fs/promises')
  const out      = new Set<string>()
  for (const pattern of CHAT_GLOBS)
    try {
      for await (const p of glob(pattern))
        out.add(p as string)
    }
    catch { /* pattern matched nothing */ }
  return [ ...out ]
}

/** One pass over all transcript files. Returns number of messages inserted. */
export async function syncOnce (): Promise<number> {
  let inserted = 0
  for (const file of await listFiles()) {
    const key = `chat:${file}`
    let wm = await getWatermark(key)
    const messages = await parseTranscript(file)
    if (messages.length <= (wm?.seq ?? 0))
      continue

    if (!wm) {
      const s = await q1<{ id: string }>(
        'INSERT INTO session (title) VALUES ($1) RETURNING id',
        [ basename(file) ],
      )
      wm = { sessionId: s!.id, seq: 0 }
    }

    await tx(async c => {
      for (let i = wm!.seq; i < messages.length; i++) {
        const m = messages[i]
        await c.query(
          `INSERT INTO message (session_id, role, seq, text, content_hash)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (session_id, seq) DO NOTHING`,
          [ wm!.sessionId, m.role, i, m.text, sha256(m.text) ],
        )
        inserted++
      }
    })
    await setWatermark(key, { sessionId: wm.sessionId, seq: messages.length })
  }
  return inserted
}

export async function runChatFeeder (signal: AbortSignal): Promise<void> {
  const interval = Number(process.env.UKDB_CHAT_INTERVAL || '5') * 1000
  while (!signal.aborted) {
    try {
      const n = await syncOnce()
      if (n)
        console.error(`[chat-feeder] +${n} messages`)
    }
    catch (err) {
      console.error(`[chat-feeder] ${err instanceof Error ? err.message : String(err)}`)
    }
    await new Promise(r => setTimeout(r, interval))
  }
}
