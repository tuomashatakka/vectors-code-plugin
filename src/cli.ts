#!/usr/bin/env bun
/**
 * vindex CLI — the same command surface as the Python vindex.py, on Bun.
 *   create | add-source | ingest | reindex | query | search | projects |
 *   here | list | status | serve | export-viewer | prompt | intent <sub>
 */
import { parseArgs } from 'node:util'
import { resolveProjectName, getOrCreateProject, getProject, addSource, listProjects } from './db/projects.ts'
import { ingestProject, reindexProject } from './db/ingest.ts'
import { searchProject, searchGlobal } from './search/search.ts'
import { closePool } from './db/pool.ts'
import { getPrompt } from './prompts.ts'
import type { SearchResult, SourceConfig } from './db/types.ts'


type OptDefs = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>['options']>

function opt (args: string[], options: OptDefs) {
  return parseArgs({ args, options, allowPositionals: true, strict: false })
}

function printResult (r: SearchResult, json: boolean) {
  if (json) {
    console.log(JSON.stringify(r, null, 2))
    return
  }
  console.log(`\n[${r.confidence.toUpperCase()}] ${r.hits.length} hits for "${r.query}" (${r.project})\n`)
  r.hits.forEach((h, i) => {
    const score = (h.rerank ?? h.score).toFixed(3)
    const where = h.project === r.project ? h.title ?? '' : `${h.project}:${h.title ?? ''}`
    console.log(`${String(i + 1).padStart(2)}. (${score}) ${where}${h.url ? `  ${h.url}` : ''}`)

    const snippet = h.text.replace(/\s+/g, ' ').slice(0, 160)
    console.log(`    ${snippet}${h.text.length > 160 ? '…' : ''}`)
  })
  console.log('')
}

// eslint-disable-next-line complexity, max-statements -- top-level command router
async function main () {
  const [ cmd, ...rest ] = process.argv.slice(2)

  switch (cmd) {
    case 'create': {
      const { positionals, values } = opt(rest, {
        root: { type: 'string' }, embed: { type: 'string' }, rerank: { type: 'string' },
      })
      const name = positionals[0]
      if (!name)
        throw new Error('usage: vindex create <name> [--root DIR] [--embed MODEL]')

      const p = await getOrCreateProject(name, {
        root:         (values.root as string) ?? process.cwd(),
        embed_model:  values.embed as string | undefined,
        rerank_model: values.rerank as string | undefined,
      })
      console.log(`created project '${p.name}' (space ${p.space_id})`)
      break
    }
    case 'add-source': {
      const { positionals, values } = opt(rest, {
        'id':       { type: 'string' },
        'type':     { type: 'string' },
        'path':     { type: 'string' },
        'glob':     { type: 'string', multiple: true },
        'base-url': { type: 'string' },
      })
      const name                 = positionals[0] || await resolveProjectName()
      const source: SourceConfig = {
        id:       (values.id as string) || 'default',
        type:     ((values.type as string) || 'dir') as SourceConfig['type'],
        path:     (values.path as string) || process.cwd(),
        globs:    (values.glob as string[]) || [ '**/*' ],
        base_url: (values['base-url'] as string) || null,
      }
      await addSource(name, source)
      console.log(`added source '${source.id}' (${source.globs.join(',')}) to '${name}'`)
      break
    }
    case 'ingest': {
      const name  = rest[0] && !rest[0].startsWith('-') ? rest[0] : await resolveProjectName()
      const stats = await ingestProject(name)
      console.log(`ingested '${name}': ${stats.filesChanged}/${stats.filesScanned} files changed, ${stats.chunks} chunks`)
      break
    }
    case 'reindex': {
      const name  = rest[0] && !rest[0].startsWith('-') ? rest[0] : await resolveProjectName()
      const stats = await reindexProject(name)
      console.log(`reindexed '${name}': ${stats.chunks} chunks from ${stats.filesScanned} files`)
      break
    }
    case 'query': {
      const { positionals, values } = opt(rest, {
        'project':   { type: 'string' },
        'topk':      { type: 'string' },
        'rerank':    { type: 'boolean' },
        'no-rerank': { type: 'boolean' },
        'json':      { type: 'boolean' },
      })
      const project = (values.project as string) || await resolveProjectName()
      const r       = await searchProject(positionals.join(' '), project, {
        topk:   values.topk ? Number(values.topk) : undefined,
        rerank: !values['no-rerank'],
      })
      printResult(r, Boolean(values.json))
      break
    }
    case 'search': {
      const { positionals, values } = opt(rest, {
        'topk':      { type: 'string' },
        'projects':  { type: 'string' },
        'no-rerank': { type: 'boolean' },
        'json':      { type: 'boolean' },
      })
      const r = await searchGlobal(positionals.join(' '), {
        topk:     values.topk ? Number(values.topk) : undefined,
        rerank:   !values['no-rerank'],
        projects: values.projects ? (values.projects as string).split(',') : undefined,
      })
      printResult(r, Boolean(values.json))
      break
    }
    case 'projects': {
      const rows   = await listProjects()
      const active = await resolveProjectName()
      for (const p of rows) {
        const mark = p.name === active ? '*' : ' '
        console.log(`${mark} ${p.name.padEnd(24)} ${p.documents} docs  ${p.chunks} chunks  (${p.embedded} embedded)`)
      }
      break
    }
    case 'list': {
      for (const p of await listProjects())
        console.log(p.name)
      break
    }
    case 'here': {
      console.log(await resolveProjectName())
      break
    }
    case 'status': {
      const name = rest[0] && !rest[0].startsWith('-') ? rest[0] : await resolveProjectName()
      const p    = await getProject(name)
      const row  = (await listProjects()).find(x => x.name === name)
      if (!p) {
        console.log(`project '${name}' not found`); break
      }
      console.log(JSON.stringify({
        name,
        root:         p.root_path,
        embed_model:  p.embed_model,
        rerank_model: p.rerank_model,
        sources:      p.sources.length,
        ...row,
      }, null, 2))
      break
    }
    case 'prompt': {
      const { positionals } = opt(rest, {})
      console.log(getPrompt(positionals[0] || 'grounded_answer'))
      break
    }
    case 'serve': {
      const { runViewer } = await import('./viewer/server.ts')
      const name          = rest[0] && !rest[0].startsWith('-') ? rest[0] : await resolveProjectName()
      await runViewer(name)
      return // long-running
    }
    case 'export-viewer': {
      const { exportViewer } = await import('./viewer/make_demo.ts')
      await exportViewer(rest[0])
      break
    }
    case 'intent': {
      const { runIntentCli } = await import('./intents/cli.ts')
      await runIntentCli(rest)
      break
    }
    default:
      console.log('commands: create add-source ingest reindex query search projects list here status prompt serve export-viewer intent')
  }
  await closePool()
}

main().catch(async err => {
  console.error(String(err?.message ?? err))
  await closePool().catch(() => {})
  process.exit(1)
})
