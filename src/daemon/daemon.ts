#!/usr/bin/env bun
/**
 * Background daemon — runs three subsystems concurrently against the shared
 * Postgres store: the chat feeder, the source feeder, and the digest-job worker.
 * Bootstraps the schema, then runs until SIGINT/SIGTERM triggers graceful
 * shutdown via an AbortController. Ported from ukdb_daemon.py.
 */
import { ensureSpace } from '../db/schema.ts'
import { closePool } from '../db/pool.ts'
import { runChatFeeder } from './feeders/chat.ts'
import { runSourceFeeder } from './feeders/source.ts'
import { runWorker } from './worker.ts'


export async function runDaemon (signal: AbortSignal): Promise<void> {
  await ensureSpace() // applies schema + default embedding space
  console.error('[ukdb] schema ready; starting feeders + worker')
  await Promise.all([
    runChatFeeder(signal),
    runSourceFeeder(signal),
    runWorker(signal),
  ])
}

if (import.meta.main) {
  const controller = new AbortController()
  const shutdown   = (sig: string) => {
    console.error(`[ukdb] ${sig} received, shutting down…`)
    controller.abort()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await runDaemon(controller.signal)
  }
  catch (err) {
    console.error(`[ukdb] fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
  finally {
    await closePool().catch(() => {})
  }
}
