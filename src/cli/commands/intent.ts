/**
 * Intent-memory commands — `vectors intent <record|recall|resolve|grade|stats>`.
 * Backed by the Postgres-backed IntentStore. The hooks spawn `intent record`
 * and `intent grade`, so those paths must stay stable.
 */
import { IntentStore } from '../../intents/store.ts'
import { resolveProjectName } from '../../db/projects.ts'
import { str, num } from '../kit.ts'
import type { Command } from '../kit.ts'


export const intentCommands: Command[] = [
  {
    path:    [ 'intent', 'record' ],
    summary: 'record a user intent (increments frequency)',
    usage:   'vectors intent record <text...> [--project P] [--session S] [--response R]',
    options: { project: { type: 'string' }, session: { type: 'string' }, response: { type: 'string' }},
    async run (ctx) {
      const store = new IntentStore()
      const id    = await store.record(ctx.positionals.join(' '), {
        project:  str(ctx, 'project') ?? await resolveProjectName(),
        session:  str(ctx, 'session'),
        response: str(ctx, 'response'),
      })
      console.log(id ? `recorded intent ${id}` : '(empty intent, ignored)')
    },
  },
  {
    path:    [ 'intent', 'recall' ],
    summary: 'recall prior resolutions for a recurring intent (fast, model-free)',
    usage:   'vectors intent recall <text...> [--project P] [--topk N]',
    options: { project: { type: 'string' }, topk: { type: 'string' }},
    async run (ctx) {
      const store   = new IntentStore()
      const matches = await store.recall(
        ctx.positionals.join(' '),
        str(ctx, 'project') ?? await resolveProjectName(),
        num(ctx, 'topk') ?? 3,
      )
      console.log(JSON.stringify(matches, null, 2))
    },
  },
  {
    path:    [ 'intent', 'resolve' ],
    summary: 'record the outcome that resolved an intent',
    usage:   'vectors intent resolve <intent> [outcome] [--score N] [--project P]',
    options: { score: { type: 'string' }, project: { type: 'string' }},
    async run (ctx) {
      const store               = new IntentStore()
      const [ intent, outcome ] = ctx.positionals
      await store.resolve(intent, outcome ?? 'resolved', num(ctx, 'score') ?? 1.0, str(ctx, 'project') ?? '')
      console.log('ok')
    },
  },
  {
    path:    [ 'intent', 'grade' ],
    summary: 'grade pending resolutions from a transcript (Ollama judge or heuristic)',
    usage:   'vectors intent grade <transcript>',
    async run (ctx) {
      const store = new IntentStore()
      const n     = await store.gradePending(ctx.positionals[0])
      console.log(`graded ${n} pending resolution(s)`)
    },
  },
  {
    path:    [ 'intent', 'stats' ],
    summary: 'show frequency leaderboard of recorded intents',
    usage:   'vectors intent stats',
    async run () {
      const store = new IntentStore()
      for (const r of await store.stats())
        console.log(`${String(r.frequency).padStart(4)}  ${r.intent_text}`)
    },
  },
]
