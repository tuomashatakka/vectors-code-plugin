#!/usr/bin/env bun
/**
 * make_demo — generate docs/viewer-demo.html from the canonical viewer.
 *
 * Takes the single source of truth (assets/viewer.html) and enables its built-in
 * demo mode by injecting `window.VINDEX_DEMO=true`, so the page renders a
 * procedural embedding cloud with no backend. Ported from make_demo_viewer.py.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'


const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FLAG = '<script>window.VINDEX_DEMO=true;</script>'

function viewerHtmlPath (): string {
  const candidates = [
    join(REPO, 'assets', 'viewer.html'),
    join(REPO, 'skills', 'vector-index', 'assets', 'viewer.html'),
  ]
  for (const c of candidates)
    if (existsSync(c))
      return c
  throw new Error('viewer.html not found in assets/')
}

export async function exportViewer (outPath?: string): Promise<string> {
  const out = outPath || join(REPO, 'docs', 'viewer-demo.html')
  let html = await readFile(viewerHtmlPath(), 'utf8')
  if (!html.includes(FLAG))
    html = html.replace('<body>', `<body>\n${FLAG}`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  return out
}

if (import.meta.main) {
  const written = await exportViewer(process.argv[2])
  console.log(`wrote demo viewer -> ${written}`)
}
