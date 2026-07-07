/**
 * Static asset serving for the 3D viewer's front-end bundle (assets/viewer/).
 * Pure path resolution (`resolveAsset`) is kept separate from fs access
 * (`serveAsset`) so the traversal/edge-case logic is unit-testable without a
 * filesystem or a running server.
 */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'


const HERE = dirname(fileURLToPath(import.meta.url))

/** Locate the built viewer asset directory, preferring the repo path over the skill mirror. */
export function viewerAssetDir (): string {
  const candidates = [
    join(HERE, '..', '..', 'assets', 'viewer'),
    join(HERE, '..', '..', 'skills', 'vector-index', 'assets', 'viewer'),
  ]
  for (const c of candidates)
    if (existsSync(join(c, 'index.html')))
      return c
  throw new Error('viewer assets not found (assets/viewer/index.html)')
}

/**
 * Resolve a request path to an absolute file path within `assetDir`, or null
 * when the request is malformed or attempts to escape the directory. Pure —
 * does not touch the filesystem.
 */
export function resolveAsset (assetDir: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  }
  catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes('//'))
    return null

  if (decoded === '/' || decoded === '/index.html')
    return join(assetDir, 'index.html')

  // Reject any raw '..' segment before normalizing — posix.normalize() silently
  //  collapses a leading '/../' at the root (there is nothing above it to escape
  //  to), which would make a post-normalize '/..' check unreachable.
  if (decoded.split('/').includes('..'))
    return null

  const normalized = posix.normalize(decoded)
  if (!normalized.startsWith('/') || normalized.startsWith('/..'))
    return null

  const abs = resolve(assetDir, '.' + normalized)
  if (abs !== assetDir && !abs.startsWith(assetDir + sep))
    return null
  return abs
}

const CONTENT_TYPES: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.json':  'application/json',
  '.map':   'application/json',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.woff2': 'font/woff2',
}

/** MIME type for a file path, by extension; unknown extensions fall back to octet-stream. */
export function contentTypeFor (path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve a static asset from `rootDir` for `urlPath`. Returns false when the
 * path doesn't resolve to a file (caller should fall through to a 404), true
 * once a response (200 or 304) has been written.
 */
export async function serveAsset (
  rootDir: string,
  urlPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const abs = resolveAsset(rootDir, urlPath)
  if (!abs)
    return false

  let st
  try {
    st = await stat(abs)
  }
  catch {
    return false
  }
  if (!st.isFile())
    return false

  const etag = `W/"${st.size}-${st.mtimeMs}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag })
    res.end()
    return true
  }

  const headers = {
    'Content-Type':  contentTypeFor(abs),
    'ETag':          etag,
    'Cache-Control': 'no-cache',
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return true
  }

  const body = await readFile(abs)
  res.writeHead(200, headers)
  res.end(body)
  return true
}
