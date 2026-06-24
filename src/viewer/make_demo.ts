#!/usr/bin/env bun
/**
 * Static viewer export. Two flavours, both producing a self-contained HTML from
 * the single source of truth (assets/viewer.html) — no server at view time:
 *
 *   exportStaticViewer()  bakes every project's sampled graph into the page as
 *                         `window.VINDEX_PROJECTS`, so the viewer opens a project
 *                         picker and renders real data offline (file://).
 *   exportViewer()        enables the built-in procedural demo (`window.VINDEX_DEMO`)
 *                         for the public docs page, where no database is present.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProjects } from '../db/projects.ts'


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

/** Bake every project's sampled graph into a standalone, offline viewer. */
export async function exportStaticViewer (outPath?: string): Promise<string> {
  const { resolveCtx, buildGraph, buildStatus }                           = await import('./server.ts')
  const out                                                               = outPath || join(REPO, 'docs', 'vectors-viewer.html')
  const projects                                                          = await listProjects()
  const payload: Array<{ name: string; status: unknown; graph: unknown }> = []
  for (const p of projects)
    try {
      const ctx = await resolveCtx(p.name)
      payload.push({ name: p.name, status: await buildStatus(ctx), graph: await buildGraph(ctx, 600, 3) })
    }
    catch {

      /* skip projects with no embedded chunks / missing space */
    }

  const inject = `<script>window.VINDEX_PROJECTS=${JSON.stringify(payload)};</script>`
  const html   = (await readFile(viewerHtmlPath(), 'utf8')).replace('<body>', `<body>\n${inject}`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  return out
}

/** Enable the procedural offline demo (no database) for the public docs page. */
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
  const demo    = process.argv.includes('--demo')
  const outArg  = process.argv.slice(2).find(a => !a.startsWith('-'))
  const written = demo ? await exportViewer(outArg) : await exportStaticViewer(outArg)
  console.log(`wrote ${demo ? 'demo' : 'static'} viewer -> ${written}`)
}
