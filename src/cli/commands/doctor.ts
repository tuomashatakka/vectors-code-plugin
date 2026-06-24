/**
 * `vectors doctor` — diagnose the environment end to end: Bun, the resolved DSN,
 * which Postgres is actually answering, pgvector, the schema, and the daemon.
 * Built after a setup session where a stale DSN pointed at the wrong Postgres
 * for an hour; this surfaces exactly that class of problem at a glance.
 */
import { DSN } from '../../config.ts'
import { q, q1 } from '../../db/pool.ts'
import type { Command } from '../kit.ts'


const OK = '✓'
const NO = '✗'

function line (ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? OK : NO} ${label}${detail ? `  ${detail}` : ''}`)
}

async function checkDb (): Promise<boolean> {
  try {
    const v = await q1<{ version: string, port: string }>(
      "select version() as version, current_setting('port') as port",
    )
    line(true, 'postgres', `${v?.version?.split(' ').slice(0, 2)
      .join(' ')} on :${v?.port}`)
  }
  catch (err) {
    line(false, 'postgres', String(err instanceof Error ? err.message : err))
    return false
  }

  const ext   = await q<{ extname: string }>("select extname from pg_extension where extname in ('vector','pg_trgm')")
  const names = ext.map(e => e.extname)
  line(names.includes('vector'), 'pgvector extension', names.join(', ') || '(none)')

  const tbls = await q<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('embedding_space','chunk','project','message')",
  )
  line(tbls.length === 4, 'schema', `${tbls.length}/4 core tables — ${tbls.length < 4 ? 'run `vectors setup`' : 'applied'}`)

  const spaces = await q<{ model: string, dim: number, table_name: string }>(
    'select model, dim, table_name from embedding_space',
  ).catch(() => [])
  for (const s of spaces)
    line(true, 'embedding space', `${s.model}/${s.dim} -> ${s.table_name}`)

  return true
}

async function checkDaemon (): Promise<void> {
  const rows = await q<{ key: string, updated_at: string }>(
    'select key, updated_at from daemon_state order by updated_at desc limit 1',
  ).catch(() => [])
  if (rows.length)
    line(true, 'daemon', `last activity ${rows[0].updated_at} (${rows[0].key})`)
  else
    line(false, 'daemon', 'no activity recorded — `vectors daemon install`')
}

export const doctorCommands: Command[] = [
  {
    path:    [ 'doctor' ],
    summary: 'diagnose Bun, the DSN, Postgres, pgvector, schema, and the daemon',
    usage:   'vectors doctor',
    async run () {
      console.log('\nvectors doctor\n')
      line(true, 'bun', Bun.version)
      line(true, 'DSN', DSN)

      const reachable = await checkDb()
      if (reachable)
        await checkDaemon()
      console.log('')
    },
  },
]
