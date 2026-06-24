/**
 * Retrieval commands — `query` (one project) and `search` (across projects),
 * plus `prompt` for printing a reasoning scaffold.
 */
import { resolveProjectName } from '../../db/projects.ts'
import { searchProject, searchGlobal } from '../../search/search.ts'
import { getPrompt } from '../../prompts.ts'
import { str, num, flag, printResult } from '../kit.ts'
import type { Command } from '../kit.ts'


export const searchCommands: Command[] = [
  {
    path:    [ 'query' ],
    summary: 'search ONE project (hybrid dense+lexical, reranked)',
    usage:   'vectors query <text...> [--project P] [--topk N] [--no-rerank] [--json]',
    options: {
      'project':   { type: 'string' },
      'topk':      { type: 'string' },
      'rerank':    { type: 'boolean' },
      'no-rerank': { type: 'boolean' },
      'json':      { type: 'boolean' },
    },
    async run (ctx) {
      const project = str(ctx, 'project') ?? await resolveProjectName()
      const r       = await searchProject(ctx.positionals.join(' '), project, {
        topk:   num(ctx, 'topk'),
        rerank: !flag(ctx, 'no-rerank'),
      })
      printResult(r, flag(ctx, 'json'))
    },
  },
  {
    path:    [ 'search' ],
    summary: 'search ACROSS every project (or a --projects subset), merged + reranked',
    usage:   'vectors search <text...> [--topk N] [--projects A,B] [--no-rerank] [--json]',
    options: {
      'topk':      { type: 'string' },
      'projects':  { type: 'string' },
      'no-rerank': { type: 'boolean' },
      'json':      { type: 'boolean' },
    },
    async run (ctx) {
      const r = await searchGlobal(ctx.positionals.join(' '), {
        topk:     num(ctx, 'topk'),
        rerank:   !flag(ctx, 'no-rerank'),
        projects: str(ctx, 'projects')?.split(','),
      })
      printResult(r, flag(ctx, 'json'))
    },
  },
  {
    path:    [ 'prompt' ],
    summary: 'print a reasoning-scaffold prompt template',
    usage:   'vectors prompt [name]',
    async run (ctx) {
      console.log(getPrompt(ctx.positionals[0] || 'grounded_answer'))
    },
  },
]
