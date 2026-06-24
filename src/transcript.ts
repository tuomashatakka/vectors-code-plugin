/**
 * transcript — tolerant parsing of chat-transcript JSONL (Claude Code / Desktop).
 *
 * Turns a harness transcript file into a flat list of `{ role, text }` message
 * pairs. Both the daemon's chat mirror and the intent-memory grader need exactly
 * this, so the logic lives here once. Stdlib only — no model stack, no database.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** One parsed, message-bearing line of a transcript. */
export interface TranscriptMessage {
  role: string;
  text: string;
}

/**
 * Tolerant: transcript `content` may be a string, a list of typed parts, or a
 * dict. Tool-result parts nest their own list of blocks, so recurse instead of
 * assuming each part flattens to a string.
 */
// eslint-disable-next-line complexity -- tolerant parser handles many content-block shapes
export function extractText (content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    const out: string[] = []
    for (const part of content)
      if (typeof part === 'string')
        out.push(part); else if (part && typeof part === 'object') {
        const rec = part as Record<string, unknown>
        let val = rec.text
        if (val === undefined || val === null)
          val = rec.content
        out.push(typeof val === 'string' ? val : extractText(val))
      }
      else
        out.push(String(part))
    return out.filter(t => t).join('\n')
  }
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>
    let val = rec.text
    if (val === undefined || val === null)
      val = rec.content
    return typeof val === 'string' ? val : extractText(val)
  }
  return ''
}

/**
 * Return `{ role, text }` for message-bearing lines, skipping tool/meta events.
 * Streams the file line-by-line and tolerates malformed JSON. NUL bytes are
 * stripped so transcripts embedding binary noise still parse safely.
 */
// eslint-disable-next-line complexity -- tolerant JSONL parser handles malformed/varied lines
export async function parseTranscript (path: string): Promise<TranscriptMessage[]> {
  const msgs: TranscriptMessage[] = []
  let stream
  try {
    stream = createReadStream(path, { encoding: 'utf-8' })
  }
  catch {
    return msgs
  }

  // Swallow ENOENT and other open errors -> empty result (matches Python).
  const errored = new Promise<boolean>(resolve => {
    stream!.once('error', () => resolve(true))
    stream!.once('open', () => resolve(false))
  })
  if (await errored)
    return msgs

  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line)
      continue

    let ev: unknown
    try {
      ev = JSON.parse(line)
    }
    catch {
      continue
    }

    const evRec = ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : null
    const m     =
      evRec && evRec.message && typeof evRec.message === 'object'
        ? (evRec.message as Record<string, unknown>)
        : null
    const role =
      (m && typeof m.role === 'string' ? m.role : undefined) ??
      (evRec && typeof evRec.type === 'string' ? evRec.type : undefined)
    if (role !== 'user' && role !== 'assistant' && role !== 'tool')
      continue

    let text = extractText(m ? m.content : evRec ? evRec.content : undefined)
    if (text.includes('\x00'))
      text = text.replaceAll('\x00', '')
    if (text.trim())
      msgs.push({ role, text })
  }
  return msgs
}

/** The trailing `n` message-bearing `{ role, text }` pairs from a transcript. */
export async function lastExchanges (path: string, n = 8): Promise<TranscriptMessage[]> {
  const msgs = await parseTranscript(path)
  return n && msgs.length > n ? msgs.slice(-n) : msgs
}
