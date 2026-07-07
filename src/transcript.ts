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
 * Harness-injected "user" text that is not a human intent: background-task
 * notifications, system reminders, slash-command envelopes, command output.
 * The intent hooks and the grader must skip these or they pollute the store.
 */
const MACHINE_TEXT_RE = /^\s*(\[SYSTEM NOTIFICATION|<(task-notification|system-reminder|local-command-stdout|command-name|command-message)\b)/

export function isMachineText (text: string): boolean {
  return MACHINE_TEXT_RE.test(text)
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
 * Yield the parsed JSON objects of a JSONL file, one per line. Swallows open
 * errors (ENOENT etc.) and skips blank or malformed lines and non-object JSON,
 * so callers only ever see records.
 */
async function * jsonlRecords (path: string): AsyncGenerator<Record<string, unknown>> {
  let stream
  try {
    stream = createReadStream(path, { encoding: 'utf-8' })
  }
  catch {
    return
  }

  // Swallow ENOENT and other open errors -> empty result (matches Python).
  const errored = new Promise<boolean>(resolve => {
    stream!.once('error', () => resolve(true))
    stream!.once('open', () => resolve(false))
  })
  if (await errored)
    return

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

    if (ev && typeof ev === 'object')
      yield ev as Record<string, unknown>
  }
}

/**
 * Return `{ role, text }` for message-bearing lines, skipping tool/meta events.
 * Streams the file line-by-line and tolerates malformed JSON. NUL bytes are
 * stripped so transcripts embedding binary noise still parse safely.
 */
export async function parseTranscript (path: string): Promise<TranscriptMessage[]> {
  const msgs: TranscriptMessage[] = []
  for await (const evRec of jsonlRecords(path)) {
    const m =
      evRec.message && typeof evRec.message === 'object'
        ? (evRec.message as Record<string, unknown>)
        : null
    const role =
      (m && typeof m.role === 'string' ? m.role : undefined) ??
      (typeof evRec.type === 'string' ? evRec.type : undefined)
    if (role !== 'user' && role !== 'assistant' && role !== 'tool')
      continue

    let text = extractText(m ? m.content : evRec.content)
    if (text.includes('\x00'))
      text = text.replaceAll('\x00', '')
    if (text.trim())
      msgs.push({ role, text })
  }
  return msgs
}

/** One prompt line of the harness's global prompt history. */
export interface PromptHistoryEntry {
  text:    string;
  project: string | null;
  ts:      number | null;
}

/**
 * Parse `~/.claude/history.jsonl`: one `{display, timestamp, project,
 * sessionId}` line per user prompt, global across projects. Blank displays,
 * slash-command stubs (`/ide` …), and machine text are skipped; NUL bytes are
 * stripped. The file is append-only and the filter is deterministic, so the
 * returned index is a stable sequence number.
 */
export async function parsePromptHistory (path: string): Promise<PromptHistoryEntry[]> {
  const out: PromptHistoryEntry[] = []
  for await (const rec of jsonlRecords(path)) {
    let display = typeof rec.display === 'string' ? rec.display : ''
    if (display.includes('\x00'))
      display = display.replaceAll('\x00', '')

    const text = display.trim()
    if (!text || text.startsWith('/') || isMachineText(text))
      continue

    out.push({
      text,
      project: typeof rec.project === 'string' ? rec.project : null,
      ts:      typeof rec.timestamp === 'number' ? rec.timestamp : null,
    })
  }
  return out
}

/** The trailing `n` message-bearing `{ role, text }` pairs from a transcript. */
export async function lastExchanges (path: string, n = 8): Promise<TranscriptMessage[]> {
  const msgs = await parseTranscript(path)
  return n && msgs.length > n ? msgs.slice(-n) : msgs
}
