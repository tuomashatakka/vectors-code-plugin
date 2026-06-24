/**
 * Schema bootstrap. Applies references/unified-knowledge-db.sql against the
 * configured DSN exactly once (guarded on the embedding_space table existing),
 * then guarantees an embedding space + its physical emb_<name> vector table.
 *
 * Run directly to bootstrap a database:  bun src/db/schema.ts
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool, q, q1 } from './pool.ts'
import type { EmbeddingSpace } from './types.ts'
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_DIM } from '../config.ts'


const HERE = dirname(fileURLToPath(import.meta.url))

/** Locate the DDL file (repo-root references first, then the legacy skill path). */
function schemaSqlPath (): string {
  const candidates = [
    join(HERE, '..', '..', 'references', 'unified-knowledge-db.sql'),
    join(HERE, '..', '..', 'skills', 'vector-index', 'references', 'unified-knowledge-db.sql'),
  ]
  for (const c of candidates)
    if (existsSync(c))
      return c
  throw new Error('unified-knowledge-db.sql not found in references/')
}

async function tableExists (name: string): Promise<boolean> {
  const row = await q1<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [ name ],
  )
  return Boolean(row?.exists)
}

// Apply the full DDL once. The whole file runs as one simple-protocol query so
//  the $$ ... $$ function bodies (which contain semicolons) stay intact.
export async function applySchema (): Promise<void> {
  if (!await tableExists('embedding_space')) {
    const sql = await readFile(schemaSqlPath(), 'utf8')
    await getPool().query(sql)
  }
  await migrate()
}

/**
 * Idempotent additive migrations on top of the DDL sketch:
 *   - project.sources: the per-project ingest source list (was config.json).
 *   - chunk.tsv: a generated tsvector + GIN index powering the sparse (BM25-ish)
 *     leg of hybrid search via ts_rank, replacing the Python BM25 sidecar.
 */
export async function migrate (): Promise<void> {
  await getPool().query(`
    ALTER TABLE project ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE chunk ADD COLUMN IF NOT EXISTS unit_type text;
    ALTER TABLE chunk ADD COLUMN IF NOT EXISTS symbol text;
    CREATE INDEX IF NOT EXISTS chunk_symbol_idx ON chunk (symbol) WHERE symbol IS NOT NULL;
    CREATE INDEX IF NOT EXISTS link_src_idx ON link (src_kind, src_id);
    ALTER TABLE chunk ADD COLUMN IF NOT EXISTS tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || text)) STORED;
    CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON chunk USING gin (tsv);
  `)
}

// Derive a physical table name from a model name + dim, e.g. all-MiniLM-L6-v2/384
//  -> emb_minilm_384. Keeps the default mapping identical to the DDL.
export function spaceTableName (model: string, dim: number): string {
  if (model === 'all-MiniLM-L6-v2' && dim === 384)
    return 'emb_minilm_384'

  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `emb_${slug}_${dim}`
}

/**
 * Ensure an embedding space exists for (model, dim, metric), creating its
 * physical vector table + HNSW index if this is a new space. Returns the row.
 */
export async function ensureSpace (
  model = DEFAULT_EMBED_MODEL,
  dim = DEFAULT_EMBED_DIM,
  metric: EmbeddingSpace['metric'] = 'cosine',
): Promise<EmbeddingSpace> {
  await applySchema()

  const table = spaceTableName(model, dim)

  const existing = await q1<EmbeddingSpace>(
    'SELECT id, model, dim, metric, table_name FROM embedding_space WHERE model=$1 AND dim=$2 AND metric=$3',
    [ model, dim, metric ],
  )
  if (existing)
    return existing

  // Create the physical table for a brand-new space (the default emb_minilm_384
  // already exists from the DDL; this branch covers any additional model).
  if (!await tableExists(table)) {
    const opclass = metric === 'l2' ? 'vector_l2_ops' : metric === 'ip' ? 'vector_ip_ops' : 'vector_cosine_ops'
    await getPool().query(`
      CREATE TABLE ${table} (
        embedding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id     uuid NOT NULL REFERENCES embedding_space(id),
        content_hash bytea NOT NULL,
        token_count  integer,
        embedding    vector(${dim}) NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (space_id, content_hash)
      );
      CREATE INDEX ${table}_hnsw ON ${table} USING hnsw (embedding ${opclass})
        WITH (m = 16, ef_construction = 64);
    `)
  }

  const row = await q1<EmbeddingSpace>(
    `INSERT INTO embedding_space (model, dim, metric, table_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (model, dim, metric) DO UPDATE SET table_name = EXCLUDED.table_name
     RETURNING id, model, dim, metric, table_name`,
    [ model, dim, metric, table ],
  )
  return row!
}

// Run as a script: bootstrap + report.
if (import.meta.main) {
  const space         = await ensureSpace()
  const { closePool } = await import('./pool.ts')
  console.log(`schema applied. default space: ${space.model}/${space.dim} (${space.metric}) -> ${space.table_name} [${space.id}]`)
  await closePool()
}
