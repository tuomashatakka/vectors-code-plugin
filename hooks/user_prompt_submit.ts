#!/usr/bin/env bun
/**
 * Pre-prompt hook — recall prior resolutions for the incoming intent.
 * Wired as `UserPromptSubmit` (Claude Code, Codex) and `BeforeAgent` (Gemini
 * CLI / Antigravity); all three deliver the same `{prompt, cwd, session_id}`.
 *
 * Reads the hook payload on stdin, does a FAST, model-free recall scoped to the
 * cwd's project, and prints a compact knowledge block to stdout as
 * `hookSpecificOutput.additionalContext` — the one injection format all three
 * harnesses accept (Gemini ignores non-JSON stdout entirely). Then fires a
 * DETACHED `vindex intent record` so storage never blocks the turn. Honours
 * VINDEX_INTENT_DISABLE, has a wall-clock budget, and always exits 0.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { IntentStore } from '../src/intents/store.ts'
import type { RecallMatch } from '../src/intents/store.ts'
import { INTENT_DISABLED, INTENT_MAX_TOKENS } from '../src/config.ts'
import { isMachineText } from '../src/transcript.ts'


const HERE = dirname(fileURLToPath(import.meta.url))
const CLI  = join(HERE, '..', 'src', 'cli', 'index.ts')

async function readStdin (): Promise<Record<string, unknown>> {
  try {
    const chunks: Buffer[] = []
    for await (const c of process.stdin)
      chunks.push(c as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }
  catch {
    return {}
  }
}

/**
 * Gemini HTML-escapes `<` and `>` inside additionalContext, which would turn
 * the XML delimiters into `&lt;vindex-intent-memory&gt;`, so BeforeAgent gets a
 * markdown heading instead. Everywhere else keeps the tag pair.
 */
function delimiters (event: string): [string, string] {
  return event === 'BeforeAgent'
    ? [ '### vindex intent memory', '### end vindex intent memory' ]
    : [ '<vindex-intent-memory>', '</vindex-intent-memory>' ]
}

function formatInjection (matches: RecallMatch[], event: string): string {
  if (!matches.length)
    return ''

  const [ open, close ] = delimiters(event)
  const lines           = [ open, 'Prior resolutions for similar intents:' ]
  let budget            = INTENT_MAX_TOKENS * 4 // ~chars
  for (const m of matches) {
    const exc  = (m.response_excerpt ?? '').replace(/\s+/g, ' ').trim()
    const line = `- [${m.outcome} ${m.score.toFixed(2)}] ${m.intent}${exc ? ` → ${exc}` : ''}`
    if (line.length > budget)
      break
    budget -= line.length
    lines.push(line)
  }
  lines.push(close)
  return lines.join('\n')
}

/**
 * The portable hook response. Every harness reads
 * `hookSpecificOutput.additionalContext`; `{}` is the valid no-op (Gemini
 * requires a JSON object on stdout either way).
 */
function emit (event: string, context: string): void {
  const payload = context
    ? { hookSpecificOutput: { hookEventName: event, additionalContext: context }}
    : {}
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function fireWriter (prompt: string, cwd: string, session: string): void {
  try {
    const args = [ 'run', CLI, 'intent', 'record' ]
    if (session)
      args.push('--session', session)
    args.push('--', prompt)

    const child = spawn('bun', args, {
      cwd:      cwd || undefined,
      detached: true,
      stdio:    'ignore',
      env:      process.env,
    })
    child.unref()
  }
  catch { /* never break the turn */ }
}

async function main (): Promise<void> {
  if (INTENT_DISABLED)
    return emit('UserPromptSubmit', '')

  const payload = await readStdin()
  const event   = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'UserPromptSubmit'
  const prompt  = String(payload.prompt ?? '').trim()
  const cwd     = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const session = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (!prompt || isMachineText(prompt))
    return emit(event, '')

  const budgetMs = Number(process.env.VINDEX_INTENT_TIMEOUT || '1.5') * 1000
  const recall   = (async () => {
    const store = new IntentStore()
    try {
      return await store.recall(prompt, '', 3)
    }
    catch {
      return [] as RecallMatch[]
    }
  })()
  const timeout = new Promise<RecallMatch[]>(r => setTimeout(() => r([]), budgetMs))
  const matches = await Promise.race([ recall, timeout ])

  emit(event, formatInjection(matches, event))
  fireWriter(prompt, cwd, session)
}

main().then(() => process.exit(0))
  .catch(() => process.exit(0))
