/**
 * Lazy Postgres connection pool (node-postgres). One pool per process; the first
 * query connects. `q` is a thin tagged helper around parameterized queries.
 */
import pg from 'pg'
import { DSN } from '../config.ts'


let pool: pg.Pool | null = null

export function getPool (): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DSN, max: 8 })
    pool.on('error', err => {
      // A pooled idle client erroring should not crash the process.
      console.error('[pg] idle client error:', err.message)
    })
  }
  return pool
}

/** Run a parameterized query and return the rows. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow> (
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as unknown[])
  return res.rows
}

/** Run a query expecting exactly one row (or null). */
export async function q1<T extends pg.QueryResultRow = pg.QueryResultRow> (
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params)
  return rows[0] ?? null
}

/** Run `fn` inside a transaction, rolling back on throw. */
export async function tx<T> (fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const out = await fn(client)
    await client.query('COMMIT')
    return out
  }
  catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
  finally {
    client.release()
  }
}

/** Format a number[] as a pgvector text literal, e.g. "[0.1,0.2,...]". */
export function toVector (values: number[] | Float32Array): string {
  return '[' + Array.from(values).join(',') + ']'
}

export async function closePool (): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
