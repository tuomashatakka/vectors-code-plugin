/**
 * CHAT FEEDER — mirror Claude transcripts into session/message. Watches the
 * CHAT_GLOBS (~/.claude/projects/**\/*.jsonl — the `**` also covers nested
 * subagents/*.jsonl — plus ~/.claude/history.jsonl), parses new lines past a
 * per-file watermark in daemon_state, and upserts them. New message rows
 * auto-enqueue an `embed` digest job via the DDL trigger.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { q, q1, tx } from '../../db/pool.ts'
import { parseTranscript, parsePromptHistory } from '../../transcript.ts'
import { CHAT_GLOBS, CHAT_INTERVAL } from '../../config.ts'


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
  const { glob, stat } = await import('node:fs/promises')
  const out            = new Set<string>()
  for (const pattern of CHAT_GLOBS)
    try {
      // A pattern without glob magic is a literal file path — glob() (notably
      // Bun's) yields nothing for those, so stat it directly.
      if (!(/[*?[{]/).test(pattern)) {
        if ((await stat(pattern)).isFile())
          out.add(pattern)
        continue
      }
      for await (const p of glob(pattern))
        out.add(p as string)
    }
    catch { /* pattern matched nothing */ }
  return [ ...out ]
}

/**
 * Mirror the harness's global prompt history (~/.claude/history.jsonl) into one
 * synthetic `claude-history` session. Each kept line becomes a `role='user'`
 * message whose seq is its filtered index (the file is append-only and the
 * filter deterministic, so the sequence is stable). The line's `project` path
 * is resolved to a vectors project via `root_path` for the denormalized
 * `message.project_id`; its `timestamp` becomes `created_at`.
 */
async function syncHistory (file: string): Promise<number> {
  const key     = `chat:${file}`
  let wm        = await getWatermark(key)
  const entries = await parsePromptHistory(file)
  if (entries.length <= (wm?.seq ?? 0))
    return 0

  if (!wm) {
    const s = await q1<{ id: string }>(
      'INSERT INTO session (title) VALUES ($1) RETURNING id',
      [ 'claude-history' ],
    )
    wm = { sessionId: s!.id, seq: 0 }
  }

  // Resolve project paths -> ids once per pass (consecutive lines repeat them).
  const projectIds = new Map<string, string | null>()
  for (const e of entries.slice(wm.seq))
    if (e.project && !projectIds.has(e.project)) {
      const row = await q1<{ id: string }>('SELECT id FROM project WHERE root_path = $1', [ e.project ])
      projectIds.set(e.project, row?.id ?? null)
    }

  let inserted = 0
  await tx(async c => {
    for (let i = wm!.seq; i < entries.length; i++) {
      const e = entries[i]
      await c.query(
        `INSERT INTO message (session_id, project_id, role, seq, text, content_hash, created_at)
         VALUES ($1,$2,'user',$3,$4,$5,COALESCE(to_timestamp($6::double precision / 1000.0), now()))
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [ wm!.sessionId, e.project ? projectIds.get(e.project) ?? null : null, i, e.text, sha256(e.text), e.ts ],
      )
      inserted++
    }
  })
  await setWatermark(key, { sessionId: wm.sessionId, seq: entries.length })
  return inserted
}

/** One pass over all transcript files. Returns number of messages inserted. */
export async function syncOnce (): Promise<number> {
  let inserted = 0
  for (const file of await listFiles()) {
    if (basename(file) === 'history.jsonl') {
      inserted += await syncHistory(file)
      continue
    }

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
  const interval = CHAT_INTERVAL * 1000
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
