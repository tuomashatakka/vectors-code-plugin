/**
 * `vectors repl` — an interactive shell over the same command registry. A bare
 * line runs a search in the current project; anything starting with a known
 * command verb dispatches that command; `:` meta-commands switch context.
 */
import { createInterface } from 'node:readline'
import { resolveProjectName } from '../../db/projects.ts'
import type { Command } from '../kit.ts'


const BANNER = 'interactive vectors — type a query, a command (e.g. `projects`), or :help / :quit. Ctrl-D exits.'

export const replCommands: Command[] = [
  {
    path:        [ 'repl' ],
    summary:     'interactive shell (query-first) over all commands',
    usage:       'vectors repl',
    longRunning: true,
    async run () {
      const { match, dispatch, helpText } = await import('../index.ts')
      let project = await resolveProjectName()
      const rl     = createInterface({ input: process.stdin, output: process.stdout })
      const prompt = () => {
        rl.setPrompt(`vectors (${project}) > `); rl.prompt()
      }

      console.log(BANNER)
      prompt()
      for await (const raw of rl) {
        const s = raw.trim()
        if (!s) {
          prompt(); continue
        }
        try {
          if (s === ':quit' || s === ':q')
            break
          else if (s === ':help' || s === ':h')
            console.log(helpText())
          else if (s.startsWith(':project '))
            project = s.slice(9).trim() || project
          else if (s.startsWith(':global '))
            await dispatch(match([ 'search' ])!.cmd, [ s.slice(':global '.length).trim() ])
          else {
            const hit = match(s.split(/\s+/))
            if (hit && !hit.cmd.longRunning)
              await dispatch(hit.cmd, hit.rest)
            else
              await dispatch(match([ 'query' ])!.cmd, [ s, '--project', project ])
          }
        }
        catch (err) {
          console.error(String(err instanceof Error ? err.message : err))
        }
        prompt()
      }
      rl.close()
    },
  },
]
