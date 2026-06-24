/**
 * `vectors setup` — the single setup command. Installs deps (if missing),
 * applies the schema + migrations against the resolved DSN, ensures the default
 * embedding space, and optionally links the global `vectors` bin and installs
 * the background daemon. Full provisioning (Postgres, daemon, editor/MCP wiring)
 * lives in setup.sh; this command is the re-runnable schema/space core.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { applySchema, migrate, ensureSpace } from '../../db/schema.ts'
import { DSN } from '../../config.ts'
import { flag } from '../kit.ts'
import type { Command } from '../kit.ts'


const HERE = dirname(fileURLToPath(import.meta.url)) // src/cli/commands
const REPO = join(HERE, '..', '..', '..')

async function sh (cmd: string[], cwd = REPO): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}

export const setupCommands: Command[] = [
  {
    path:    [ 'setup' ],
    summary: 'install deps, apply the schema, and optionally link the CLI + daemon',
    usage:   'vectors setup [--link] [--daemon] [--no-deps]',
    options: {
      'link':    { type: 'boolean' },
      'daemon':  { type: 'boolean' },
      'no-deps': { type: 'boolean' },
      'yes':     { type: 'boolean' },
    },
    async run (ctx) {
      if (!flag(ctx, 'no-deps') && !existsSync(join(REPO, 'node_modules'))) {
        console.log('>> installing dependencies (bun install)')
        await sh([ 'bun', 'install' ])
      }

      console.log(`>> applying schema (${DSN})`)
      await applySchema()
      await migrate()

      const space = await ensureSpace()
      console.log(`   schema ready. default space: ${space.model}/${space.dim} (${space.metric}) -> ${space.table_name}`)

      if (flag(ctx, 'link')) {
        console.log('>> linking global `vectors` bin (bun link)')
        await sh([ 'bun', 'link' ])
      }

      if (flag(ctx, 'daemon')) {
        console.log('>> installing background daemon')
        await sh([ 'bash', join(REPO, 'skills', 'vector-index', 'daemon', 'install.sh') ])
      }

      console.log('\n>> setup complete.')
      console.log('   full install / wiring:  bash setup.sh')
      console.log('   verify:                 vectors doctor')
    },
  },
]
