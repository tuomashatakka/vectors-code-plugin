/**
 * Project commands. `index` is the whole index flow in one shot — create the
 * project (if new), attach a source, and ingest it (incremental diff-by-hash).
 * The root defaults to the cwd and a Git `origin` remote becomes the citation
 * URL template, so `cd repo && vectors index repo` just works. `ls` lists
 * projects (and prints one project's config + stats when given a name).
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { resolveProjectName, getOrCreateProject, getProject, projectByRoot, addSource, listProjects } from '../../db/projects.ts'
import { ingestProject } from '../../db/ingest.ts'
import { defaultProjectName } from '../../manifest.ts'
import { assertWritable, assertAllowedRoot } from '../../guards.ts'
import { str, flag } from '../kit.ts'
import type { Command } from '../kit.ts'
import type { SourceConfig } from '../../db/types.ts'


/** A broad code+docs default so `vectors index <name>` needs no `--glob`. */
const DEFAULT_GLOBS = [ '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,rb,php,c,h,cc,cpp,hpp,cs,swift,scala,sh,sql,md,mdx,mdc,txt,rst,json,yaml,yml,toml}' ]

/** Expand a leading `~` and resolve to an absolute path. */
function resolvePathArg (p: string): string {
  const s = p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p
  return isAbsolute(s) ? resolve(s) : resolve(process.cwd(), s)
}

/** Derive a GitHub-style blob base-url ({path} template) from `origin`. */
async function gitBaseUrl (root: string): Promise<string | null> {
  try {
    const p = Bun.spawn([ 'git', '-C', root, 'remote', 'get-url', 'origin' ], { stdout: 'pipe', stderr: 'ignore' })
    if (await p.exited !== 0)
      return null

    const raw = (await new Response(p.stdout).text()).trim()
    const m   = raw.match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/)
    return m ? `https://${m[1]}/${m[2]}/blob/HEAD/{path}` : null
  }
  catch {
    return null
  }
}

export const projectCommands: Command[] = [
  {
    path:    [ 'index' ],
    summary: 'create + ingest a project in one step (incremental on re-run)',
    usage:   'vectors index [name] [path] [--glob G ...] [--embed MODEL] [--rerank MODEL] [--url TEMPLATE] [--rebuild]',
    options: {
      glob:    { type: 'string', multiple: true },
      embed:   { type: 'string' },
      rerank:  { type: 'string' },
      url:     { type: 'string' },
      rebuild: { type: 'boolean' },
    },
    async run (ctx) {
      assertWritable('index')

      const root = resolvePathArg(ctx.positionals[1] ?? process.cwd())
      assertAllowedRoot(root)

      // Bare `vectors index`: reuse the project already anchored at this root,
      // else derive a name from the package manifest (falling back to the
      // directory basename). An explicit first positional is always the name.
      let name = ctx.positionals[0]
      if (!name) {
        const anchored = await projectByRoot(root)
        name           = anchored?.name ?? await defaultProjectName(root)
        if (!anchored) {
          const clash = await getProject(name)
          if (clash?.root_path && clash.root_path !== root)
            throw new Error(`project '${name}' already exists for ${clash.root_path} — pass an explicit name: vectors index <name> [path]`)
        }
      }
      if (!name)
        throw new Error('usage: vectors index [name] [path] [--glob G ...]')

      await getOrCreateProject(name, {
        root,
        embed_model:  str(ctx, 'embed'),
        rerank_model: str(ctx, 'rerank'),
      })

      const globList             = ctx.values.glob as string[] | undefined
      const source: SourceConfig = {
        id:       'default',
        type:     'dir',
        path:     root,
        globs:    globList?.length ? globList : DEFAULT_GLOBS,
        base_url: str(ctx, 'url') ?? await gitBaseUrl(root),
      }
      await addSource(name, source)

      console.log(`indexing '${name}' <- ${root}`)

      const stats = await ingestProject(name, flag(ctx, 'rebuild'))
      console.log(`  ${stats.filesChanged}/${stats.filesScanned} files changed, ${stats.chunks} chunks embedded`)
    },
  },
  {
    path:    [ 'ls' ],
    summary: 'list projects with stats (* = active); pass a name for its config',
    usage:   'vectors ls [name] [--json]',
    options: { json: { type: 'boolean' }},
    async run (ctx) {
      const name = ctx.positionals[0]
      if (name) {
        const p = await getProject(name)
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
          sources:      p.sources,
          ...row,
        }, null, 2))
        return
      }

      const rows = await listProjects()
      if (flag(ctx, 'json')) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (!rows.length) {
        console.log('no projects yet — run `vectors index <name> [path]`')
        return
      }

      const active = await resolveProjectName()
      for (const p of rows) {
        const mark = p.name === active ? '*' : ' '
        console.log(`${mark} ${p.name.padEnd(24)} ${String(p.documents).padStart(5)} docs  ${String(p.chunks).padStart(6)} chunks  (${p.embedded} embedded)`)
      }
    },
  },
]
