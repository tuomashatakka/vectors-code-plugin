/**
 * Database inspection — `vectors db` lists the tables, `vectors db <table>`
 * prints rows as an aligned terminal table.
 *
 * This is a debugging surface over the live store, so it leans on the catalog
 * rather than a hardcoded table list: whatever `applySchema()`/`migrate()` have
 * created shows up here. Identifiers are never taken from argv directly — a
 * name is matched against the catalog first and only the catalog's own spelling
 * is interpolated, so there is no injection path through the table/column args.
 */
import { q } from '../../db/pool.ts'
import { str, num, flag } from '../kit.ts'
import type { Command, Ctx } from '../kit.ts'


/** Hard ceiling for one cell before the width budget even gets a say. */
const MAX_CELL = 120

/** Never squeeze a column below this — narrower is unreadable. */
const MIN_COL = 6

/** Fallback when stdout is not a TTY (piped output). */
const FALLBACK_WIDTH = 120

interface TableInfo {
  name:  string;
  rows:  number;
  bytes: number;
}

/** Every base table in `public`, with exact row counts and on-disk size. */
async function listTables (): Promise<TableInfo[]> {
  const names = await q<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  )
  if (!names.length)
    return []

  // One round trip for exact counts: reltuples is an estimate and goes stale
  // between ANALYZEs, which is misleading in a "show me what's in there" tool.
  const union = names
    .map(({ name }) => `SELECT '${name}' AS name, count(*)::bigint AS rows, pg_total_relation_size('"${name}"') AS bytes FROM "${name}"`)
    .join(' UNION ALL ')
  const rows = await q<{ name: string; rows: string; bytes: string }>(union)
  return rows
    .map(r => ({ name: r.name, rows: Number(r.rows), bytes: Number(r.bytes) }))
    .sort((a, b) => b.rows - a.rows)
}

/** The catalog's own spelling of `want`, or null when no such table exists. */
async function resolveTable (want: string): Promise<string | null> {
  const row = await q<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND lower(tablename)=lower($1)`,
    [ want ],
  )
  return row[0]?.name ?? null
}

/** Column names of `table`, in declaration order. `table` must already be catalog-verified. */
async function columnsOf (table: string): Promise<string[]> {
  const rows = await q<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [ table ],
  )
  return rows.map(r => r.name)
}

function humanBytes (n: number): string {
  const units = [ 'B', 'kB', 'MB', 'GB', 'TB' ]
  let v = n,
    u   = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)}${units[u]}`
}

/**
 * One value as display text. The store is full of things a terminal should
 * never see raw: sha256 `bytea`, 384-float `vector` literals, `tsvector`
 * postings, and whole file bodies in `document.content`. Each collapses to a
 * summary instead of flooding the screen.
 */

function renderCell (v: unknown, full: boolean): string {
  if (v === null || v === undefined)
    return '∅'
  if (Buffer.isBuffer(v))
    return full ? `\\x${v.toString('hex')}` : `\\x${v.toString('hex').slice(0, 8)}…`
  if (v instanceof Date)
    return v.toISOString().replace('T', ' ')
      .slice(0, 19)
  if (Array.isArray(v) || typeof v === 'object' && v !== null)
    return JSON.stringify(v)
  if (typeof v !== 'string')
    return String(v)

  // pgvector has no type parser registered, so it arrives as "[0.1,0.2,…]".
  if (!full && v.startsWith('[') && v.endsWith(']') && v.length > 64)
    return `⟨${v.split(',').length}d⟩`
  return v.replace(/\s+/g, ' ')
}

function clip (s: string, width: number): string {
  return s.length <= width ? s.padEnd(width) : s.slice(0, Math.max(1, width - 1)) + '…'
}

/**
 * Decide the rendered width of each column.
 *
 * `natural[i]` is what column i would like: the longest of its header and its
 * cells (already capped at MAX_CELL). `budget` is how many characters are left
 * for content after the separators are accounted for. When the naturals fit,
 * everyone gets what they asked for; when they do not, something has to give.
 *
 * TODO(you): implement the over-budget policy — see the note in the reply.
 * Current behaviour is a flat equal split, which is correct but blunt: it
 * punishes a 4-char `seq` column exactly as hard as a 2000-char `text` column.
 */
function allocateWidths (natural: number[], budget: number): number[] {
  const total = natural.reduce((a, b) => a + b, 0)
  if (total <= budget)
    return natural

  const each = Math.max(MIN_COL, Math.floor(budget / natural.length))
  return natural.map(n => Math.min(n, each))
}

/** Header + rule + rows, aligned to the terminal (or FALLBACK_WIDTH when piped). */
function renderTable (headers: string[], rows: string[][], termWidth: number): string {
  const natural = headers.map((h, i) =>
    Math.min(MAX_CELL, Math.max(h.length, ...rows.map(r => r[i].length), MIN_COL)))
  const budget = Math.max(MIN_COL * headers.length, termWidth - 3 * (headers.length - 1))
  const widths = allocateWidths(natural, budget)
  const line   = (cells: string[]): string => cells.map((c, i) => clip(c, widths[i])).join('   ')
    .trimEnd()

  return [
    line(headers),
    widths.map(w => '─'.repeat(w)).join('───'),
    ...rows.map(line),
  ].join('\n')
}

function terminalWidth (): number {
  return process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : FALLBACK_WIDTH
}

/** `vectors db` — the catalog overview. */
async function showOverview (json: boolean): Promise<void> {
  const tables = await listTables()
  if (json) {
    console.log(JSON.stringify(tables, null, 2))
    return
  }
  if (!tables.length) {
    console.log('no tables — run `vectors setup` to apply the schema')
    return
  }

  const rows = tables.map(t => [ t.name, t.rows.toLocaleString(), humanBytes(t.bytes) ])
  console.log('')
  console.log(renderTable([ 'table', 'rows', 'size' ], rows, terminalWidth()))
  console.log(`\n${tables.length} tables, ${tables.reduce((a, t) => a + t.rows, 0).toLocaleString()} rows total`)
  console.log('inspect one:  vectors db <table> [--limit N]\n')
}

/** Which columns to select, or an error string naming what was wrong. */
function pickColumns (spec: string | undefined, available: string[], table: string): string[] | string {
  if (!spec)
    return available

  const picked  = spec.split(',').map(s => s.trim())
    .filter(Boolean)
  const unknown = picked.filter(c => !available.includes(c))
  if (unknown.length)
    return `unknown column(s) on ${table}: ${unknown.join(', ')}\navailable: ${available.join(', ')}`
  return picked.length ? picked : available
}

/** `vectors db <table>` — one table's rows. */
async function showRows (ctx: Ctx, want: string, json: boolean): Promise<void> {
  const table = await resolveTable(want)
  if (!table) {
    console.log(`no table '${want}'. known tables: ${(await listTables()).map(t => t.name).join(', ')}`)
    return
  }

  const available = await columnsOf(table)
  const cols      = pickColumns(str(ctx, 'cols'), available, table)
  if (typeof cols === 'string') {
    console.log(cols)
    return
  }

  const order = str(ctx, 'order')
  if (order && !available.includes(order)) {
    console.log(`cannot order by '${order}' — ${table} has: ${available.join(', ')}`)
    return
  }

  const limit  = num(ctx, 'limit') ?? 20
  const offset = num(ctx, 'offset') ?? 0
  const where  = str(ctx, 'where')
  const sql    = [
    `SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${table}"`,
    where ? `WHERE ${where}` : '',
    order ? `ORDER BY "${order}"${flag(ctx, 'desc') ? ' DESC' : ''}` : '',
    `LIMIT ${limit} OFFSET ${offset}`,
  ].filter(Boolean).join(' ')

  const rows = await q(sql)
  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (!rows.length) {
    console.log(`${table}: no rows${where ? ' matching --where' : ''}`)
    return
  }

  const full  = flag(ctx, 'full')
  const cells = rows.map(r => cols.map(c => renderCell(r[c], full)))
  console.log('')
  console.log(renderTable(cols, cells, terminalWidth()))

  const total = await q<{ n: string }>(`SELECT count(*)::bigint AS n FROM "${table}"${where ? ` WHERE ${where}` : ''}`)
  console.log(`\n${rows.length} of ${Number(total[0].n).toLocaleString()} rows (offset ${offset})\n`)
}

export const dbCommands: Command[] = [
  {
    path:    [ 'db' ],
    aliases: [[ 'tables' ]],
    summary: 'inspect the store: list tables, or print one table\'s rows',
    usage:   'vectors db [table] [--limit N] [--offset N] [--cols a,b] [--order COL] [--desc] [--where SQL] [--full] [--json]',
    options: {
      limit:  { type: 'string' },
      offset: { type: 'string' },
      cols:   { type: 'string' },
      order:  { type: 'string' },
      where:  { type: 'string' },
      desc:   { type: 'boolean' },
      full:   { type: 'boolean' },
      json:   { type: 'boolean' },
    },
    async run (ctx) {
      const want = ctx.positionals[0]
      const json = flag(ctx, 'json')
      await (want ? showRows(ctx, want, json) : showOverview(json))
    },
  },
]
