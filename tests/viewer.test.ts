/**
 * Viewer static-asset unit tests — pure logic only (no DB, no server). Run: bun test
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { contentTypeFor, resolveAsset } from '../src/viewer/static.ts'

const DIR = '/assets/viewer' // symbolic — resolveAsset never touches the filesystem

describe('resolveAsset', () => {
  test('/ and /index.html resolve to index.html', () => {
    expect(resolveAsset(DIR, '/')).toBe(join(DIR, 'index.html'))
    expect(resolveAsset(DIR, '/index.html')).toBe(join(DIR, 'index.html'))
  })

  test('nested paths resolve inside the dir', () => {
    expect(resolveAsset(DIR, '/js/main.js')).toBe(join(DIR, 'js/main.js'))
    expect(resolveAsset(DIR, '/vendor/x/y.js')).toBe(join(DIR, 'vendor/x/y.js'))
  })

  test('rejects traversal attempts', () => {
    const attempts = [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fx',
      '//etc/passwd',
      '/a/../../b',
    ]
    for (const p of attempts)
      expect(resolveAsset(DIR, p)).toBeNull()
  })

  test('rejects embedded NUL, backslashes, and malformed encoding', () => {
    expect(resolveAsset(DIR, '/foo\0bar')).toBeNull()
    expect(resolveAsset(DIR, '/%00bar')).toBeNull()
    expect(resolveAsset(DIR, '/foo\\bar')).toBeNull()
    expect(resolveAsset(DIR, '/%zz')).toBeNull()
  })
})

describe('contentTypeFor', () => {
  test('maps every known extension', () => {
    expect(contentTypeFor('a.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('a.js')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('a.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('a.json')).toBe('application/json')
    expect(contentTypeFor('a.map')).toBe('application/json')
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('a.png')).toBe('image/png')
    expect(contentTypeFor('a.woff2')).toBe('font/woff2')
  })

  test('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('a')).toBe('application/octet-stream')
  })
})

describe('asset dir parity', () => {
  const repoRoot = join(import.meta.dir, '..')
  const rootDir  = join(repoRoot, 'assets', 'viewer')
  const skillDir = join(repoRoot, 'skills', 'vector-index', 'assets', 'viewer')

  async function walk (dir: string): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      out.push(...entry.isDirectory() ? await walk(abs) : [ abs ])
    }
    return out
  }

  async function hash (path: string): Promise<string> {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  }

  test('root and skill viewer bundles are byte-identical', async () => {
    // Activates automatically once the front-end bundle lands in both places.
    if (!existsSync(rootDir) || !existsSync(skillDir))
      return

    const rootFiles  = (await walk(rootDir)).map(f => relative(rootDir, f)).sort()
    const skillFiles = (await walk(skillDir)).map(f => relative(skillDir, f)).sort()
    expect(skillFiles).toEqual(rootFiles)

    for (const rel of rootFiles)
      expect(await hash(join(skillDir, rel))).toBe(await hash(join(rootDir, rel)))
  })
})
