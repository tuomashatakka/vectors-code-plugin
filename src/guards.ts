/**
 * guards — capability & environment guards (C9).
 *
 * The plugin is read-mostly, but ingest / reindex / create_project / add_source
 * mutate state and read arbitrary filesystem paths, so they assert an enablement
 * guard *before any logic runs*:
 *
 *   VINDEX_READONLY=1          block all mutating operations
 *   VINDEX_ALLOW_ROOTS=a:b:c   only ingest/create from under these roots
 *
 * Policy is read from config.ts (resolved once at process start).
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { READONLY, ALLOW_ROOTS } from './config.ts'

/** Expand a leading `~` and resolve to an absolute, normalized path. */
function resolvePath (p: string): string {
  let s = p
  if (s === '~')
    s = homedir()
  else if (s.startsWith('~/'))
    s = homedir() + s.slice(1)
  return isAbsolute(s) ? resolve(s) : resolve(process.cwd(), s)
}

const ROOTS = ALLOW_ROOTS.map(resolvePath)

/** True when the process is in read-only mode. */
export function readonly (): boolean {
  return READONLY
}

/** Throw if mutations are disabled. `action` names the blocked operation. */
export function assertWritable (action = 'operation'): void {
  if (READONLY)
    throw new Error(`${action} blocked: VINDEX_READONLY is set (read-only mode)`)
}

/** True if `p` lies under some allow-root; unrestricted when none are configured. */
export function pathAllowed (p: string): boolean {
  if (ROOTS.length === 0)
    return true

  const target = resolvePath(p)
  return ROOTS.some(
    root => target === root || target.startsWith(root.endsWith('/') ? root : root + '/'),
  )
}

/** Throw if `p` is outside every ALLOW_ROOTS entry (no-op when list is empty). */
export function assertAllowedRoot (p: string): void {
  if (!pathAllowed(p))
    throw new Error(`${p} is outside VINDEX_ALLOW_ROOTS`)
}
