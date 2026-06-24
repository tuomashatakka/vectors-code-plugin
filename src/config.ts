/**
 * Central configuration: environment variables, default paths, and the Postgres
 * DSN. Mirrors the VINDEX_* surface of the old Python plugin so behaviour and
 * env-var names are preserved across the rewrite.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'


const env = process.env

function xdgDataHome (): string {
  return env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share')
}

/** Truthy check matching the Python `os.environ.get(x) in {"1","true",...}` idiom. */
function flag (name: string): boolean {
  const v = (env[name] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** Global RAG home (config + caches live here; vectors now live in Postgres). */
export const VINDEX_HOME =
  env.VINDEX_HOME && env.VINDEX_HOME.trim()
    ? env.VINDEX_HOME
    : join(xdgDataHome(), 'vector-index')

/** Default models — identical logical names to the Python defaults. */
export const DEFAULT_EMBED_MODEL = env.VINDEX_EMBED_MODEL || 'all-MiniLM-L6-v2'
export const DEFAULT_RERANK_MODEL =
  env.VINDEX_RERANK_MODEL || 'cross-encoder/ms-marco-MiniLM-L6-v2'
export const DEFAULT_EMBED_DIM = 384

/** Project resolution knobs. */
export const VINDEX_PROJECT = (env.VINDEX_PROJECT || '').trim()
export const VINDEX_DEFAULT = (env.VINDEX_DEFAULT || 'default').trim()

/** Capability guards. */
export const READONLY = flag('VINDEX_READONLY')
export const ALLOW_ROOTS = (env.VINDEX_ALLOW_ROOTS || '')
  .split(':')
  .map(s => s.trim())
  .filter(Boolean)

/** Intent-memory knobs. */
export const INTENT_DISABLED = flag('VINDEX_INTENT_DISABLE')
export const INTENT_SYNC_EMBED = flag('VINDEX_INTENT_SYNC_EMBED')
export const INTENT_NO_JUDGE = flag('VINDEX_INTENT_NO_JUDGE')
export const INTENT_MIN_SCORE = Number(env.VINDEX_INTENT_MIN_SCORE || '0.45')
export const INTENT_MAX_TOKENS = Number(env.VINDEX_INTENT_MAX_TOKENS || '400')

/**
 * Postgres connection string. Accepts VINDEX_DSN or the daemon's UKDB_DSN
 * (kept identical so the plugin and daemon share one store). Falls back to a
 * conventional local database.
 */
export const DSN =
  env.VINDEX_DSN ||
  env.UKDB_DSN ||
  'postgres://localhost:5432/vectors'

/** Local Ollama endpoint used for optional intent grading / digest tasks. */
export const OLLAMA_URL = env.OLLAMA_URL || 'http://127.0.0.1:11434'
export const OLLAMA_MODEL = env.VINDEX_OLLAMA_MODEL || env.UKDB_OLLAMA_MODEL || 'llama3.1:8b'

/** Where Claude Code transcripts live (watched by the daemon's chat feeder). */
export const CHAT_GLOBS = (env.UKDB_CHAT_GLOBS || join(homedir(), '.claude', 'projects', '**', '*.jsonl'))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
