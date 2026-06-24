#!/usr/bin/env bun
/**
 * Streamable-HTTP MCP server — the network-reachable counterpart of the stdio
 * server in ./server.ts. Exposes the same 13 tools over the MCP streamable-HTTP
 * transport so the server can sit behind a reverse proxy (e.g. nginx `/mcp`).
 *
 * Stateless: a fresh Server + transport is created per request
 * (`sessionIdGenerator: undefined`), which is the simplest robust shape behind a
 * load-balancing / buffering proxy. Built on node:http (runs under Bun), mirroring
 * src/viewer/server.ts.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './server.ts'
import { ensureSpace } from '../db/schema.ts'
import { closePool } from '../db/pool.ts'
import { MCP_HTTP_PORT } from '../config.ts'


/** Read the full request body and JSON-parse it (empty body → undefined). */
async function readJsonBody (req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req)
    chunks.push(chunk as Buffer)

  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw)
    return undefined
  return JSON.parse(raw)
}

/** Dispatch a single MCP request through a throwaway stateless server+transport. */
async function handleMcp (req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server    = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)

  const body = req.method === 'POST' ? await readJsonBody(req) : undefined
  await transport.handleRequest(req, res, body)
}

export async function runHttpMcp (port: number = MCP_HTTP_PORT): Promise<void> {
  await ensureSpace() // bootstrap schema + default embedding space on a fresh DB

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname
        if (path === '/health') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('ok\n')
        }
        else if (path === '/mcp')
          await handleMcp(req, res); else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      }
      catch (err) {
        if (!res.headersSent)
          res.writeHead(500, { 'Content-Type': 'application/json' })
        try {
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
        catch { /* socket gone */ }
      }
    })()
  })

  await new Promise<void>(resolve => {
    server.listen(port, '127.0.0.1', () => {
      console.error(`[vectors] MCP streamable-http server ready on http://127.0.0.1:${port}/mcp`)
      resolve()
    })
  })
}

if (import.meta.main) {
  const shutdown = (sig: string) => {
    console.error(`[vectors] ${sig} received, shutting down…`)
    void closePool().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  await runHttpMcp()
}
