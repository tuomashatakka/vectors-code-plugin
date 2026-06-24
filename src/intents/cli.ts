/**
 * `vindex intent <sub>` CLI dispatch — record | recall | resolve | grade | stats.
 * Mirrors the Python cmd_intent_* handlers. Backed by the Postgres IntentStore.
 */
import { parseArgs } from 'node:util'
import { IntentStore } from './store.ts'
import { resolveProjectName } from '../db/projects.ts'


export async function runIntentCli (args: string[]): Promise<void> {
  const [ sub, ...rest ] = args
  const store            = new IntentStore()

  switch (sub) {
    case 'record': {
      const { positionals, values } = parseArgs({
        args:             rest,
        allowPositionals: true,
        strict:           false,
        options:          { project: { type: 'string' }, session: { type: 'string' }, response: { type: 'string' }},
      })
      const id = await store.record(positionals.join(' '), {
        project:  (values.project as string) ?? await resolveProjectName(),
        session:  values.session as string | undefined,
        response: values.response as string | undefined,
      })
      console.log(id ? `recorded intent ${id}` : '(empty intent, ignored)')
      break
    }
    case 'recall': {
      const { positionals, values } = parseArgs({
        args:             rest,
        allowPositionals: true,
        strict:           false,
        options:          { project: { type: 'string' }, topk: { type: 'string' }},
      })
      const matches = await store.recall(
        positionals.join(' '),
        (values.project as string) ?? await resolveProjectName(),
        values.topk ? Number(values.topk) : 3,
      )
      console.log(JSON.stringify(matches, null, 2))
      break
    }
    case 'resolve': {
      const { positionals, values } = parseArgs({
        args:             rest,
        allowPositionals: true,
        strict:           false,
        options:          { score: { type: 'string' }, project: { type: 'string' }},
      })
      const [ intent, outcome ] = positionals
      await store.resolve(intent, outcome ?? 'resolved', values.score ? Number(values.score) : 1.0,
                          (values.project as string) ?? '')
      console.log('ok')
      break
    }
    case 'grade': {
      const n = await store.gradePending(rest[0])
      console.log(`graded ${n} pending resolution(s)`)
      break
    }
    case 'stats': {
      const rows = await store.stats()
      for (const r of rows)
        console.log(`${String(r.frequency).padStart(4)}  ${r.intent_text}`)
      break
    }
    default:
      console.log('intent subcommands: record recall resolve grade stats')
  }
}
