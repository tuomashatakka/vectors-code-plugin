#!/usr/bin/env bun
/**
 * vectors — the unified CLI. A small command registry shared by this
 * flag-driven front-end and the interactive TUI. Each command lives in
 * ./commands/*; dispatch matches the longest registered path in argv.
 *
 *   vectors                        interactive TUI (autocomplete + switcher)
 *   vectors <group> <sub> [args]   e.g. `vectors daemon start`
 *   vectors index <name> [path]    create + ingest a project in one step
 *   vectors help [--all]           this listing (--all includes agent commands)
 */
import { closePool } from '../db/pool.ts'
import { parse } from './kit.ts'
import type { Command } from './kit.ts'
import { projectCommands } from './commands/project.ts'
import { searchCommands } from './commands/search.ts'
import { viewerCommands } from './commands/viewer.ts'
import { intentCommands } from './commands/intent.ts'
import { mcpCommands } from './commands/mcp.ts'
import { setupCommands } from './commands/setup.ts'
import { doctorCommands } from './commands/doctor.ts'
import { daemonCommands } from './commands/daemon.ts'
import { dbCommands } from './commands/db.ts'


export const COMMANDS: Command[] = [
  ...setupCommands,
  ...projectCommands,
  ...searchCommands,
  ...viewerCommands,
  ...intentCommands,
  ...daemonCommands,
  ...mcpCommands,
  ...doctorCommands,
  ...dbCommands,
]

function allPaths (c: Command): string[][] {
  return [ c.path, ...c.aliases ?? [] ]
}

/** Find the command whose canonical path or alias is the longest prefix of argv. */
export function match (argv: string[]): { cmd: Command, rest: string[] } | null {
  let best: { cmd: Command, len: number } | null = null
  for (const cmd of COMMANDS)
    for (const p of allPaths(cmd))
      if (p.length <= argv.length && p.every((seg, i) => argv[i] === seg))
        if (!best || p.length > best.len)
          best = { cmd, len: p.length }
  return best ? { cmd: best.cmd, rest: argv.slice(best.len) } : null
}

/** Run a resolved command: parse its options, invoke it, return whether it is long-running. */
export async function dispatch (cmd: Command, rest: string[]): Promise<boolean> {
  const ctx = parse(rest, cmd.options ?? {})
  await cmd.run(ctx)
  return Boolean(cmd.longRunning)
}

export function helpText (showAll = false): string {
  const groups = new Map<string, Command[]>()
  for (const c of COMMANDS) {
    if (c.hidden && !showAll)
      continue

    const g = c.path.length > 1 ? c.path[0] : 'core'
    if (!groups.has(g))
      groups.set(g, [])
    groups.get(g)!.push(c)
  }

  const lines: string[] = [
    'vectors — local semantic search over your code & docs\n',
    'usage: vectors <command> [args]   (bare `vectors` opens the interactive TUI)\n',
  ]
  for (const [ g, cmds ] of [ ...groups ].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${g}:`)
    for (const c of cmds)
      lines.push(`  ${(c.usage ?? c.path.join(' ')).padEnd(58)} ${c.summary}`)
    lines.push('')
  }
  if (!showAll)
    lines.push('(run `vectors help --all` to show advanced / agent commands)\n')
  return lines.join('\n')
}

async function main (): Promise<void> {
  const argv = process.argv.slice(2)

  // Bare invocation -> interactive TUI.
  if (!argv.length) {
    const { runTui } = await import('./tui.ts')
    await runTui()
    await closePool()
    return
  }

  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(helpText(argv.includes('--all')))
    return
  }

  const hit = match(argv)
  if (!hit) {
    console.error(`unknown command: ${argv.join(' ')}\n`)
    console.log(helpText())
    process.exitCode = 1
    return
  }

  const longRunning = await dispatch(hit.cmd, hit.rest)
  if (!longRunning)
    await closePool()
}

main().catch(async err => {
  console.error(String(err?.message ?? err))
  await closePool().catch(() => {})
  process.exit(1)
})
