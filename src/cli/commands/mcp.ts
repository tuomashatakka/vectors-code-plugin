/**
 * `vectors mcp` — run the stdio MCP server (the same entry editors wire up).
 * Importing the module starts the server and binds the stdio transport.
 */
import type { Command } from '../kit.ts'


export const mcpCommands: Command[] = [
  {
    path:        [ 'mcp' ],
    summary:     'run the stdio MCP server (for editors / Claude)',
    usage:       'vectors mcp',
    longRunning: true,
    async run () {
      await import('../../mcp/server.ts')
    },
  },
]
