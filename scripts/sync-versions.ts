#!/usr/bin/env bun
/**
 * Keep static version fields in lockstep with package.json (the source of
 * truth). The MCP serverInfo already imports package.json directly; this
 * covers manifests that cannot (.claude-plugin/plugin.json). `--check` exits
 * nonzero on drift instead of rewriting (for CI / setup.sh).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root    = join(import.meta.dir, '..')
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
const check   = process.argv.includes('--check')

const pluginPath = join(root, '.claude-plugin', 'plugin.json')
const raw        = readFileSync(pluginPath, 'utf8')
const plugin     = JSON.parse(raw) as { version: string }

if (plugin.version === version) {
  console.log(`versions in sync (${version})`)
  process.exit(0)
}
if (check) {
  console.error(`version drift: package.json ${version} != plugin.json ${plugin.version}`)
  process.exit(1)
}
writeFileSync(pluginPath, raw.replace(`"version": "${plugin.version}"`, `"version": "${version}"`))
console.log(`plugin.json ${plugin.version} -> ${version}`)
