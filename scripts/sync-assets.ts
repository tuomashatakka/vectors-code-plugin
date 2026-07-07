#!/usr/bin/env bun
/**
 * Mirror the built viewer front-end (assets/viewer/) into the skill's copy
 * (skills/vector-index/assets/viewer/) so both installs — in-repo and the
 * packaged skill — ship the same bundle. `--check` reports drift and exits
 * nonzero without writing (for CI / setup.sh), mirroring sync-versions.ts.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const root  = join(import.meta.dir, '..')
const src   = join(root, 'assets', 'viewer')
const dst   = join(root, 'skills', 'vector-index', 'assets', 'viewer')
const check = process.argv.includes('--check')

if (!existsSync(src)) {
  console.error(`source not found: ${src} (nothing to sync yet)`)
  process.exit(1)
}

async function walk (dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    out.push(...entry.isDirectory() ? await walk(abs) : [ abs ])
  }
  return out
}

const hash = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

const srcFiles = await walk(src)
const dstFiles = existsSync(dst) ? await walk(dst) : []
const srcRel   = new Set(srcFiles.map(f => relative(src, f)))
const drift: string[] = []

for (const abs of srcFiles) {
  const rel    = relative(src, abs)
  const dstAbs = join(dst, rel)
  const srcBuf = await readFile(abs)
  const same   = existsSync(dstAbs) && hash(await readFile(dstAbs)) === hash(srcBuf)
  if (!same) {
    drift.push(rel)
    if (!check) {
      await mkdir(dirname(dstAbs), { recursive: true })
      await writeFile(dstAbs, srcBuf)
    }
  }
}

for (const abs of dstFiles) {
  const rel = relative(dst, abs)
  if (!srcRel.has(rel)) {
    drift.push(`- ${rel}`)
    if (!check)
      await rm(abs)
  }
}

if (!drift.length) {
  console.log('assets already in sync')
  process.exit(0)
}
if (check) {
  console.error('asset drift:')
  for (const d of drift)
    console.error(`  ${d}`)
  process.exit(1)
}
console.log(`synced ${drift.length} file(s) -> ${dst}`)
