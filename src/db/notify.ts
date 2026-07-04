/**
 * Live event bus over Postgres LISTEN/NOTIFY. Every search and ingest emits a
 * JSON payload on the `vindex_events` channel; the viewer server LISTENs and
 * fans the stream out to browsers over SSE (`GET /api/events`), so activity
 * from any entry point (CLI, MCP, daemon, viewer) shows up live in the mesh.
 * Emission is strictly best-effort — a failed notify never breaks the caller.
 */
import { getPool } from './pool.ts'


export const EVENT_CHANNEL = 'vindex_events'

// NOTIFY payloads are capped at ~8000 bytes; leave headroom for the envelope.
const MAX_PAYLOAD = 7600

let seq = 0

/** Emit one event on the bus. Oversized payloads fall back to the envelope only. */
export async function notifyEvent (type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const envelope = { type, seq: ++seq, at: new Date().toISOString() }
    let body       = JSON.stringify({ ...envelope, ...payload })
    if (body.length > MAX_PAYLOAD)
      body = JSON.stringify({ ...envelope, truncated: true, project: payload.project ?? null })
    await getPool().query('SELECT pg_notify($1, $2)', [ EVENT_CHANNEL, body ])
  }
  catch {

    /* best-effort — never fail the operation that triggered the event */
  }
}
