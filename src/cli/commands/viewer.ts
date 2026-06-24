/**
 * Viewer — `vectors viewer [name]` writes a self-contained static HTML with
 * every project's graph baked in (offline, double-clickable, no server). Pass
 * `--serve` to run the live HTTP viewer for one project instead (fresh,
 * unsampled data, project switching via /api/projects).
 */
import { resolveProjectName } from '../../db/projects.ts'
import { firstName, flag } from '../kit.ts'
import type { Command } from '../kit.ts'


export const viewerCommands: Command[] = [
  {
    path:    [ 'viewer' ],
    summary: 'write a static offline viewer (all projects) — or run --serve live',
    usage:   'vectors viewer [name] [outPath] [--serve]',
    options: { serve: { type: 'boolean' }},
    async run (ctx) {
      if (flag(ctx, 'serve')) {
        const { runViewer } = await import('../../viewer/server.ts')
        await runViewer(firstName(ctx.argv) ?? await resolveProjectName())
        await new Promise<void>(() => {}) // keep the pool open while serving
        return
      }

      const { exportStaticViewer } = await import('../../viewer/make_demo.ts')
      const out                    = await exportStaticViewer(ctx.positionals[0])
      console.log(`wrote static viewer -> ${out}`)
    },
  },
]
