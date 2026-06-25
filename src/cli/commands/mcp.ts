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
  {
    path:        [ 'mcp', 'http' ],
    summary:     'run the streamable-HTTP MCP server (network-reachable, for reverse proxies)',
    usage:       'vectors mcp http',
    longRunning: true,
    async run () {
      const { runHttpMcp } = await import('../../mcp/http.ts')
      await runHttpMcp() // resolves once listening; the open socket keeps the process alive
    },
  },
]
