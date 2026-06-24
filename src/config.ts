/**
 * Central configuration. `VINDEX_*` is the canonical env prefix; the background
 * daemon's legacy `UKDB_*` names are accepted as deprecated aliases through
 * envAny(), so the plugin and the daemon share one configuration surface.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'


const env = process.env

/** First non-empty value among the given env var names, else the fallback. */
function envAny (names: string[], fallback = ''): string {
  for (const n of names) {
    const v = env[n]
    if (v && v.trim())
      return v.trim()
  }
  return fallback
}

/** Truthy check (matches the Python `in {"1","true","yes","on"}` idiom). */
function flag (...names: string[]): boolean {
  const v = envAny(names).toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function xdgDataHome (): string {
  return envAny([ 'XDG_DATA_HOME' ]) || join(homedir(), '.local', 'share')
}

/** Global RAG home (config + caches live here; vectors live in Postgres). */
export const VINDEX_HOME = envAny([ 'VINDEX_HOME' ]) || join(xdgDataHome(), 'vector-index')

/** Default models — identical logical names to the Python defaults. */
export const DEFAULT_EMBED_MODEL = envAny([ 'VINDEX_EMBED_MODEL' ], 'all-MiniLM-L6-v2')
export const DEFAULT_RERANK_MODEL = envAny([ 'VINDEX_RERANK_MODEL' ], 'cross-encoder/ms-marco-MiniLM-L6-v2')
export const DEFAULT_EMBED_DIM = 384

/** Project resolution knobs. */
export const VINDEX_PROJECT = envAny([ 'VINDEX_PROJECT' ])
export const VINDEX_DEFAULT = envAny([ 'VINDEX_DEFAULT' ], 'default')

/** Capability guards. */
export const READONLY = flag('VINDEX_READONLY')
export const ALLOW_ROOTS = envAny([ 'VINDEX_ALLOW_ROOTS' ]).split(':')
  .map(s => s.trim())
  .filter(Boolean)

/** Intent-memory knobs. */
export const INTENT_DISABLED = flag('VINDEX_INTENT_DISABLE')
export const INTENT_SYNC_EMBED = flag('VINDEX_INTENT_SYNC_EMBED')
export const INTENT_NO_JUDGE = flag('VINDEX_INTENT_NO_JUDGE')
export const INTENT_MIN_SCORE = Number(envAny([ 'VINDEX_INTENT_MIN_SCORE' ], '0.45'))
export const INTENT_MAX_TOKENS = Number(envAny([ 'VINDEX_INTENT_MAX_TOKENS' ], '400'))

/** Postgres DSN. Canonical VINDEX_DSN; UKDB_DSN accepted as a daemon alias. */
export const DSN = envAny([ 'VINDEX_DSN', 'UKDB_DSN' ], 'postgres://localhost:5432/vectors')

/** Local Ollama endpoint used for optional intent grading / digest tasks. */
export const OLLAMA_URL = envAny([ 'VINDEX_OLLAMA_URL', 'UKDB_OLLAMA_URL', 'OLLAMA_URL' ], 'http://127.0.0.1:11434')
export const OLLAMA_MODEL = envAny([ 'VINDEX_OLLAMA_MODEL', 'UKDB_OLLAMA_MODEL' ], 'llama3.1:8b')

/** Where Claude Code transcripts live (watched by the daemon's chat feeder). */
export const CHAT_GLOBS = envAny([ 'VINDEX_CHAT_GLOBS', 'UKDB_CHAT_GLOBS' ], join(homedir(), '.claude', 'projects', '**', '*.jsonl'))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

/** Daemon cadence, in seconds. Canonical VINDEX_*; UKDB_* aliases. */
export const CHAT_INTERVAL = Number(envAny([ 'VINDEX_CHAT_INTERVAL', 'UKDB_CHAT_INTERVAL' ], '5'))
export const SOURCE_INTERVAL = Number(envAny([ 'VINDEX_SOURCE_INTERVAL', 'UKDB_SOURCE_INTERVAL' ], '300'))

/** 3D viewer HTTP port. */
export const VIEWER_PORT = Number(envAny([ 'VINDEX_VIEWER_PORT', 'PORT' ], '7341'))
