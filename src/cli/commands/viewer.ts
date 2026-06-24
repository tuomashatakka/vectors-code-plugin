/**
 * Viewer commands — `serve` runs the live 3D synapse viewer HTTP server;
 * `viewer export` writes the standalone demo HTML (no backend).
 */
import { resolveProjectName } from '../../db/projects.ts'
import { firstName } from '../kit.ts'
import type { Command } from '../kit.ts'


export const viewerCommands: Command[] = [
  {
    path:        [ 'serve' ],
    summary:     'run the 3D synapse viewer HTTP server for a project',
    usage:       'vectors serve [name]',
    longRunning: true,
    async run (ctx) {
      const { runViewer } = await import('../../viewer/server.ts')
      const name          = firstName(ctx.argv) ?? await resolveProjectName()
      await runViewer(name)
    },
  },
  {
    path:    [ 'viewer', 'export' ],
    aliases: [[ 'export-viewer' ]],
    summary: 'write the standalone demo viewer HTML',
    usage:   'vectors viewer export [outPath]',
    async run (ctx) {
      const { exportViewer } = await import('../../viewer/make_demo.ts')
      const out              = await exportViewer(ctx.positionals[0])
      console.log(`wrote demo viewer -> ${out}`)
    },
  },
]
