/**
 * Shared CLI kit — command types, arg parsing, and result formatting used by
 * every command module, the flag-driven dispatcher (`vectors <cmd>`), and the
 * interactive REPL (`vectors repl`). One definition surface so both front-ends
 * behave identically.
 */
import { parseArgs } from 'node:util'
import type { SearchResult } from '../db/types.ts'


export type OptDefs = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>['options']>

/** Parsed invocation handed to a command's `run`. */
export interface Ctx {
  positionals: string[]
  values:      Record<string, unknown>
  argv:        string[] // raw args after the command path
}

/** A single CLI command. `path` is its canonical invocation, e.g. ['project','create']. */
export interface Command {
  path:         string[]
  aliases?:     string[][] // alternate paths, e.g. [['create']]
  summary:      string
  usage?:       string
  options?:     OptDefs
  longRunning?: boolean // skip closePool()/exit after run (servers)
  hidden?:      boolean // omit from the default `vectors help` listing
  run:          (ctx: Ctx) => Promise<void>
}

export function parse (argv: string[], options: OptDefs = {}): Ctx {
  const { positionals, values } = parseArgs({ args: argv, options, allowPositionals: true, strict: false })
  return { positionals, values, argv }
}

export function str (ctx: Ctx, key: string): string | undefined {
  const v = ctx.values[key]
  return typeof v === 'string' && v.length ? v : undefined
}

export function num (ctx: Ctx, key: string): number | undefined {
  const v = str(ctx, key)
  return v === undefined ? undefined : Number(v)
}

export function flag (ctx: Ctx, key: string): boolean {
  return ctx.values[key] === true
}

/** First positional that is not a flag, else fall back to the resolver. */
export function firstName (argv: string[]): string | undefined {
  return argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined
}

/** Pretty-print a SearchResult (or raw JSON with `--json`). */
export function printResult (r: SearchResult, json = false): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(`\n[${r.confidence.toUpperCase()}] ${r.hits.length} hits for "${r.query}" (${r.project})\n`)
  r.hits.forEach((h, i) => {
    const score = (h.rerank ?? h.score).toFixed(3)
    const where = h.project === r.project ? h.title ?? '' : `${h.project}:${h.title ?? ''}`
    console.log(`${String(i + 1).padStart(2)}. (${score}) ${where}${h.url ? `  ${h.url}` : ''}`)

    const snippet = h.text.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`    ${snippet}${h.text.length > 160 ? '…' : ''}`)
  })
  console.log('')
}
