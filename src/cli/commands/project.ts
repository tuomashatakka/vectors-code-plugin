/**
 * Project lifecycle commands — create, add-source, ingest, reindex, and the
 * read-only listings (projects / list / here / status). Grouped under
 * `vectors project <sub>`; the bare verbs are kept as back-compat aliases.
 */
import { resolveProjectName, getOrCreateProject, getProject, addSource, listProjects } from '../../db/projects.ts'
import { ingestProject, reindexProject } from '../../db/ingest.ts'
import { str, firstName } from '../kit.ts'
import type { Command, Ctx } from '../kit.ts'
import type { SourceConfig } from '../../db/types.ts'


async function nameFrom (ctx: Ctx): Promise<string> {
  return firstName(ctx.argv) ?? await resolveProjectName()
}

export const projectCommands: Command[] = [
  {
    path:    [ 'project', 'create' ],
    aliases: [[ 'create' ]],
    summary: 'create a new project',
    usage:   'vectors project create <name> [--root DIR] [--embed MODEL] [--rerank MODEL]',
    options: { root: { type: 'string' }, embed: { type: 'string' }, rerank: { type: 'string' }},
    async run (ctx) {
      const name = ctx.positionals[0]
      if (!name)
        throw new Error('usage: vectors project create <name> [--root DIR] [--embed MODEL]')

      const p = await getOrCreateProject(name, {
        root:         str(ctx, 'root') ?? process.cwd(),
        embed_model:  str(ctx, 'embed'),
        rerank_model: str(ctx, 'rerank'),
      })
      console.log(`created project '${p.name}' (space ${p.space_id})`)
    },
  },
  {
    path:    [ 'project', 'add-source' ],
    aliases: [[ 'add-source' ]],
    summary: 'add an ingest source to a project',
    usage:   'vectors project add-source [name] [--id ID] [--type dir|repo] [--path PATH] [--glob GLOB ...] [--base-url URL]',
    options: {
      'id':       { type: 'string' },
      'type':     { type: 'string' },
      'path':     { type: 'string' },
      'glob':     { type: 'string', multiple: true },
      'base-url': { type: 'string' },
    },
    async run (ctx) {
      const name                 = ctx.positionals[0] || await resolveProjectName()
      const source: SourceConfig = {
        id:       str(ctx, 'id') || 'default',
        type:     (str(ctx, 'type') || 'dir') as SourceConfig['type'],
        path:     str(ctx, 'path') || process.cwd(),
        globs:    (ctx.values.glob as string[]) || [ '**/*' ],
        base_url: str(ctx, 'base-url') || null,
      }
      await addSource(name, source)
      console.log(`added source '${source.id}' (${source.globs.join(',')}) to '${name}'`)
    },
  },
  {
    path:    [ 'project', 'ingest' ],
    aliases: [[ 'ingest' ]],
    summary: "(re)ingest a project's configured sources (incremental)",
    usage:   'vectors project ingest [name]',
    async run (ctx) {
      const name  = await nameFrom(ctx)
      const stats = await ingestProject(name)
      console.log(`ingested '${name}': ${stats.filesChanged}/${stats.filesScanned} files changed, ${stats.chunks} chunks`)
    },
  },
  {
    path:    [ 'project', 'reindex' ],
    aliases: [[ 'reindex' ]],
    summary: 'wipe and rebuild a project from scratch',
    usage:   'vectors project reindex [name]',
    async run (ctx) {
      const name  = await nameFrom(ctx)
      const stats = await reindexProject(name)
      console.log(`reindexed '${name}': ${stats.chunks} chunks from ${stats.filesScanned} files`)
    },
  },
  {
    path:    [ 'projects' ],
    summary: 'list all projects with document/chunk counts (* = active)',
    usage:   'vectors projects',
    async run () {
      const rows   = await listProjects()
      const active = await resolveProjectName()
      for (const p of rows) {
        const mark = p.name === active ? '*' : ' '
        console.log(`${mark} ${p.name.padEnd(24)} ${p.documents} docs  ${p.chunks} chunks  (${p.embedded} embedded)`)
      }
    },
  },
  {
    path:    [ 'list' ],
    summary: 'list project names, one per line',
    usage:   'vectors list',
    async run () {
      for (const p of await listProjects())
        console.log(p.name)
    },
  },
  {
    path:    [ 'here' ],
    summary: 'print the project the current directory resolves to',
    usage:   'vectors here',
    async run () {
      console.log(await resolveProjectName())
    },
  },
  {
    path:    [ 'status' ],
    aliases: [[ 'project', 'status' ]],
    summary: "show a project's config and stats",
    usage:   'vectors status [name]',
    async run (ctx) {
      const name = await nameFrom(ctx)
      const p    = await getProject(name)
      if (!p) {
        console.log(`project '${name}' not found`)
        return
      }

      const row = (await listProjects()).find(x => x.name === name)
      console.log(JSON.stringify({
        name,
        root:         p.root_path,
        embed_model:  p.embed_model,
        rerank_model: p.rerank_model,
        sources:      p.sources.length,
        ...row,
      }, null, 2))
    },
  },
]
