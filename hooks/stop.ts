#!/usr/bin/env bun
/**
 * Stop hook — grade the just-finished exchange.
 *
 * Reads the hook payload on stdin (transcript_path, cwd, session_id) and fires a
 * DETACHED `vindex intent grade <transcript>` so the (possibly slow) Ollama judge
 * never holds up the turn. Honours VINDEX_INTENT_DISABLE and always exits 0.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { INTENT_DISABLED } from '../src/config.ts'


const HERE = dirname(fileURLToPath(import.meta.url))
const CLI  = join(HERE, '..', 'src', 'cli.ts')

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

async function main (): Promise<void> {
  if (INTENT_DISABLED)
    return

  const payload    = await readStdin()
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
  if (!transcript || !existsSync(transcript))
    return

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()

  try {
    const child = spawn('bun', [ 'run', CLI, 'intent', 'grade', transcript ], {
      cwd: cwd || undefined, detached: true, stdio: 'ignore', env: process.env,
    })
    child.unref()
  }
  catch { /* never break the turn */ }
}

main().then(() => process.exit(0))
  .catch(() => process.exit(0))
