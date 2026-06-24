/**
 * `vectors daemon <start|stop|status|logs>` — manage the background sync daemon.
 * `start`/`stop` delegate to the platform scripts (launchd on macOS, systemd
 * --user on Linux); `status`/`logs` wrap the platform service manager. The
 * hidden `run` executes the daemon in the foreground (used by the service).
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Command } from '../kit.ts'


const HERE       = dirname(fileURLToPath(import.meta.url)) // src/cli/commands
const DAEMON_DIR = join(HERE, '..', '..', '..', 'skills', 'vector-index', 'daemon')
const LABEL      = 'com.vectors.ukdb'
const MAC        = process.platform === 'darwin'
const UID        = typeof process.getuid === 'function' ? process.getuid() : 0
const LOG        = MAC
  ? join(homedir(), 'Library', 'Logs', 'ukdb-daemon.out.log')
  : join(homedir(), '.local', 'state', 'ukdb', 'ukdb-daemon.out.log')

async function sh (cmd: string[]): Promise<number> {
  const p = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}

export const daemonCommands: Command[] = [
  {
    path:    [ 'daemon', 'start' ],
    summary: 'install + start the background sync daemon (launchd/systemd)',
    usage:   'vectors daemon start',
    async run (ctx) {
      await sh([ 'bash', join(DAEMON_DIR, 'install.sh'), ...ctx.argv ])
    },
  },
  {
    path:    [ 'daemon', 'stop' ],
    summary: 'stop + remove the background daemon service',
    usage:   'vectors daemon stop',
    async run (ctx) {
      await sh([ 'bash', join(DAEMON_DIR, 'uninstall.sh'), ...ctx.argv ])
    },
  },
  {
    path:    [ 'daemon', 'status' ],
    summary: 'show the daemon service status',
    usage:   'vectors daemon status',
    async run () {
      await (MAC
        ? sh([ 'launchctl', 'print', `gui/${UID}/${LABEL}` ])
        : sh([ 'systemctl', '--user', 'status', 'ukdb-daemon.service' ]))
    },
  },
  {
    path:        [ 'daemon', 'logs' ],
    summary:     'follow the daemon output log',
    usage:       'vectors daemon logs',
    longRunning: true,
    async run () {
      await sh([ 'tail', '-n', '50', '-f', LOG ])
    },
  },
  {
    path:        [ 'daemon', 'run' ],
    hidden:      true,
    summary:     'run the daemon in the foreground (used by the service)',
    usage:       'vectors daemon run',
    longRunning: true,
    async run () {
      const { runDaemon } = await import('../../daemon/daemon.ts')
      const controller    = new AbortController()
      for (const sig of [ 'SIGINT', 'SIGTERM' ] as const)
        process.on(sig, () => controller.abort())
      await runDaemon(controller.signal)
    },
  },
]
