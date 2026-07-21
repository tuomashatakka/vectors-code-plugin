/**
 * transcript — tolerant parsing of harness chat transcripts.
 *
 * Turns a transcript file into a flat list of `{ role, text }` message pairs.
 * Both the daemon's chat mirror and the intent-memory grader need exactly this,
 * so the logic lives here once. Stdlib only — no model stack, no database.
 *
 * Three on-disk formats are understood, detected from the first line:
 * - **Claude Code / Desktop** — JSONL, `{ message: { role, content } }` per line.
 * - **Codex** — JSONL rollouts, `{ payload: { type: 'message', role, content } }`.
 * - **Gemini CLI / Antigravity** — ONE JSON document with a `messages` array.
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
 *
 * The trailing entries are Codex's — it files its plugin suggestions, its
 * permission preamble, and the AGENTS.md injection under `role: 'user'` like
 * any typed prompt.
 */
const MACHINE_TEXT_RE = /^\s*(\[SYSTEM NOTIFICATION|# AGENTS\.md instructions|<(task-notification|system-reminder|local-command-stdout|command-name|command-message|recommended_plugins|environment_context|user_instructions|permissions instructions)\b)/

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

/** The first non-blank line, without reading the rest of the file. */
async function firstLine (path: string): Promise<string> {
  let stream
  try {
    stream = createReadStream(path, { encoding: 'utf-8' })
  }
  catch {
    return ''
  }

  const errored = new Promise<boolean>(resolve => {
    stream!.once('error', () => resolve(true))
    stream!.once('open', () => resolve(false))
  })
  if (await errored)
    return ''

  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const raw of rl)
      if (raw.trim())
        return raw.trim()
    return ''
  }
  finally {
    rl.close()
    stream.destroy()
  }
}

function isRecord (v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/** Append `{ role, text }`, stripping NUL bytes and dropping empty text. */
function push (msgs: TranscriptMessage[], role: string, content: unknown): void {
  let text = extractText(content)
  if (text.includes('\x00'))
    text = text.replaceAll('\x00', '')
  if (text.trim())
    msgs.push({ role, text })
}

/**
 * Gemini CLI / Antigravity: one JSON document, `messages: [{ type, content }]`
 * where `type` is `user | gemini | info | error`. Only the first two are turns —
 * `info`/`error` are UI notices (update banners, MCP warnings).
 */
async function parseChatDocument (path: string): Promise<TranscriptMessage[]> {
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, 'utf-8'))
  }
  catch {
    return []
  }
  if (!isRecord(doc) || !Array.isArray(doc.messages))
    return []

  const msgs: TranscriptMessage[] = []
  for (const entry of doc.messages) {
    if (!isRecord(entry))
      continue

    const type = typeof entry.type === 'string' ? entry.type : ''
    const role = type === 'gemini' ? 'assistant' : type
    if (role !== 'user' && role !== 'assistant')
      continue
    push(msgs, role, entry.content)
  }
  return msgs
}

/**
 * Codex rollouts wrap every event as `{ timestamp, type, payload }`; the turns
 * are `payload.type === 'message'`. `developer` (the system preamble) is not a
 * turn, so only user/assistant survive.
 */
function codexMessage (rec: Record<string, unknown>): { role: string; content: unknown } | null {
  if (!isRecord(rec.payload) || rec.payload.type !== 'message')
    return null

  const role = typeof rec.payload.role === 'string' ? rec.payload.role : ''
  if (role !== 'user' && role !== 'assistant')
    return null
  return { role, content: rec.payload.content }
}

/**
 * Claude Code / Desktop: `{ message: { role, content } }`, falling back to a
 * top-level `type` for the older shape that carries the role there.
 */
function claudeMessage (rec: Record<string, unknown>): { role: string; content: unknown } | null {
  const m    = isRecord(rec.message) ? rec.message : null
  const role =
    (m && typeof m.role === 'string' ? m.role : undefined) ??
    (typeof rec.type === 'string' ? rec.type : undefined)
  if (role !== 'user' && role !== 'assistant' && role !== 'tool')
    return null
  return { role, content: m ? m.content : rec.content }
}

/**
 * True when the file is a single JSON document rather than JSONL: either it
 * does not parse line-by-line (pretty-printed, opening on a bare `{`) or line
 * one already carries the whole `messages` array (minified).
 */
function isChatDocument (head: string): boolean {
  let probe: unknown
  try {
    probe = JSON.parse(head)
  }
  catch {
    return true
  }
  return isRecord(probe) && Array.isArray(probe.messages)
}

/**
 * Return `{ role, text }` for message-bearing entries, skipping tool/meta
 * events. The format is detected from the first line: anything that is not a
 * standalone JSON object per line is read as a single Gemini chat document.
 * Tolerates malformed JSON; NUL bytes are stripped so transcripts embedding
 * binary noise still parse safely.
 */
export async function parseTranscript (path: string): Promise<TranscriptMessage[]> {
  const head = await firstLine(path)
  if (!head)
    return []
  if (isChatDocument(head))
    return parseChatDocument(path)

  const msgs: TranscriptMessage[] = []
  for await (const evRec of jsonlRecords(path)) {
    const msg = codexMessage(evRec) ?? claudeMessage(evRec)
    if (!msg)
      continue

    push(msgs, msg.role, msg.content)
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
