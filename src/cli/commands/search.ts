/**
 * Retrieval — one `search` command. It searches the current project by default;
 * pass `--global` (or prefix the query with `all:`) or `--projects A,B` to merge
 * and rerank across projects. The hidden `prompt` prints a reasoning scaffold.
 */
import { resolveProjectName } from '../../db/projects.ts'
import { searchProject, searchGlobal } from '../../search/search.ts'
import { getPrompt } from '../../prompts.ts'
import { str, num, flag, printResult } from '../kit.ts'
import type { Command } from '../kit.ts'


export const searchCommands: Command[] = [
  {
    path:    [ 'search' ],
    summary: 'search the current project (--global / "all:" searches every project)',
    usage:   'vectors search <text...> [--project P] [--global] [--projects A,B] [--topk N] [--no-rerank] [--json]',
    options: {
      'project':   { type: 'string' },
      'global':    { type: 'boolean' },
      'projects':  { type: 'string' },
      'topk':      { type: 'string' },
      'no-rerank': { type: 'boolean' },
      'json':      { type: 'boolean' },
    },
    async run (ctx) {
      let text       = ctx.positionals.join(' ')
      const rerank   = !flag(ctx, 'no-rerank')
      const topk     = num(ctx, 'topk')
      const projects = str(ctx, 'projects')?.split(',')

      let global = flag(ctx, 'global') || Boolean(projects)
      if (text.startsWith('all:')) {
        text   = text.slice(4).trim()
        global = true
      }

      const r = global
        ? await searchGlobal(text, { topk, rerank, projects })
        : await searchProject(text, str(ctx, 'project') ?? await resolveProjectName(), { topk, rerank })
      printResult(r, flag(ctx, 'json'))
    },
  },
  {
    path:    [ 'prompt' ],
    hidden:  true,
    summary: 'print a reasoning-scaffold prompt template',
    usage:   'vectors prompt [name]',
    async run (ctx) {
      console.log(getPrompt(ctx.positionals[0] || 'grounded_answer'))
    },
  },
]
