/**
 * Viewer — `vectors viewer [name]` runs the live 3D synapse viewer server for
 * one project; `--all` serves the whole store instead (project switcher via
 * /api/projects), `--port` overrides the default port.
 */
import { resolveProjectName } from '../../db/projects.ts'
import { firstName, flag, num } from '../kit.ts'
import type { Command } from '../kit.ts'


export const viewerCommands: Command[] = [
  {
    path:        [ 'viewer' ],
    summary:     'run the live 3D viewer server',
    usage:       'vectors viewer [name] [--all] [--port N]',
    options:     { all: { type: 'boolean' }, port: { type: 'string' }},
    longRunning: true,
    async run (ctx) {
      const { runViewer, ALL_SCOPE } = await import('../../viewer/server.ts')
      const name                     = flag(ctx, 'all') ? ALL_SCOPE : firstName(ctx.argv) ?? await resolveProjectName()
      const port                     = num(ctx, 'port')
      // resolves once listening; the open socket keeps the process alive
      await (port === undefined ? runViewer(name) : runViewer(name, port))
    },
  },
]
