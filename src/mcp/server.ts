#!/usr/bin/env bun
/**
 * MCP stdio server exposing the vector-index tools to Claude Code / Desktop.
 * Tool names + arguments mirror the Python mcp_server.py 1:1 so the plugin
 * surface is unchanged. Uses the SDK's low-level Server with JSON Schema tool
 * definitions (no top-level zod dependency).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveProjectName, getProject, getOrCreateProject, addSource, listProjects } from '../db/projects.ts'
import { ingestProject, reindexProject } from '../db/ingest.ts'
import { searchProject, searchGlobal } from '../search/search.ts'
import { checkGroundedness, resolveReference } from '../search/references.ts'
import type { SourceConfig } from '../db/types.ts'


const S = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const, properties: props, required,
})
const str  = { type: 'string' }
const num  = { type: 'number' }
const bool = { type: 'boolean' }

const TOOLS = [
  { name:        'search',
    description: 'Search ONE project (auto-resolved from cwd if omitted). Hybrid dense+lexical, reranked.',
    inputSchema: S({ query: str, project: str, topk: num, rerank: bool }, [ 'query' ]) },
  { name:        'search_global',
    description: 'Search across EVERY project (or a comma-list subset). Merged + reranked.',
    inputSchema: S({ query: str, topk: num, rerank: bool, projects: str }, [ 'query' ]) },
  { name:        'current_project',
    description: 'Which project does the current working directory resolve to?',
    inputSchema: S({}) },
  { name: 'list_projects', description: 'List all projects with document/chunk counts.', inputSchema: S({}) },
  { name: 'project_status', description: 'Status + config for a project.', inputSchema: S({ project: str }) },
  { name: 'ingest', description: "(Re)ingest a project's configured sources (incremental).", inputSchema: S({ project: str }) },
  { name: 'reindex', description: 'Wipe + rebuild a project from scratch.', inputSchema: S({ project: str }) },
  { name: 'create_project', description: 'Create a project.', inputSchema: S({ name: str, root: str, embed_model: str, rerank_model: str }, [ 'name' ]) },
  { name:        'add_source',
    description: 'Add an ingest source (dir or repo) to a project.',
    inputSchema: S({ project: str, id: str, type: str, path: str, globs: str, base_url: str }, [ 'path' ]) },
  { name:        'validate_citations',
    description: "Check whether claims/citations in text are grounded in a project's corpus.",
    inputSchema: S({ text: str, project: str, topk: num }, [ 'text' ]) },
  { name:        'resolve_reference',
    description: 'Resolve a URI/citation to a title+snippet (optionally fetching the network).',
    inputSchema: S({ uri: str, network: bool }, [ 'uri' ]) },
  { name:        'recall_intents',
    description: 'Recall prior resolutions for a recurring user intent (fast, model-free).',
    inputSchema: S({ query: str, project: str, topk: num }, [ 'query' ]) },
  { name:        'resolve_intent',
    description: 'Record the outcome that resolved an intent.',
    inputSchema: S({ intent: str, outcome: str, score: num, project: str }, [ 'intent', 'outcome' ]) },
]

const text = (data: unknown) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]})

interface ToolArgs {
  query?:        string;
  project?:      string;
  topk?:         number;
  rerank?:       boolean;
  projects?:     string
  text?:         string;
  uri?:          string;
  network?:      boolean;
  name?:         string;
  root?:         string
  embed_model?:  string;
  rerank_model?: string;
  id?:           string;
  type?:         string;
  path?:         string
  globs?:        string;
  base_url?:     string;
  intent?:       string;
  outcome?:      string;
  score?:        number
}

// eslint-disable-next-line complexity -- a 13-tool router is inherently branchy
async function dispatch (name: string, a: ToolArgs) {
  switch (name) {
    case 'search':
      return text(await searchProject(a.query ?? '', a.project || await resolveProjectName(), { topk: a.topk, rerank: a.rerank ?? true }))
    case 'search_global':
      return text(await searchGlobal(a.query ?? '', { topk: a.topk, rerank: a.rerank ?? true, projects: a.projects ? a.projects.split(',') : undefined }))
    case 'current_project':
      return text({ project: await resolveProjectName() })
    case 'list_projects':
      return text(await listProjects())
    case 'project_status': {
      const proj = await getProject(a.project || await resolveProjectName())
      return text(proj ?? { error: 'not found' })
    }
    case 'ingest':
      return text(await ingestProject(a.project || await resolveProjectName()))
    case 'reindex':
      return text(await reindexProject(a.project || await resolveProjectName()))
    case 'create_project':
      return text(await getOrCreateProject(a.name ?? '', { root: a.root, embed_model: a.embed_model, rerank_model: a.rerank_model }))
    case 'add_source': {
      const project              = a.project || await resolveProjectName()
      const source: SourceConfig = {
        id:       a.id || 'default',
        type:     (a.type || 'dir') as SourceConfig['type'],
        path:     a.path ?? process.cwd(),
        globs:    a.globs ? a.globs.split(',') : [ '**/*' ],
        base_url: a.base_url ?? null,
      }
      await addSource(project, source)
      return text({ ok: true, project, source })
    }
    case 'validate_citations': {
      const project = a.project || await resolveProjectName()
      const r       = await searchProject(a.text ?? '', project, { topk: a.topk ?? 5, rerank: true })
      return text(checkGroundedness(a.text ?? '', r.hits.map(h => h.text)))
    }
    case 'resolve_reference':
      return text(await resolveReference(a.uri ?? '', { network: Boolean(a.network) }))
    case 'recall_intents': {
      const { IntentStore } = await import('../intents/store.ts')
      return text(await new IntentStore().recall(a.query ?? '', a.project ?? '', a.topk ?? 3))
    }
    case 'resolve_intent': {
      const { IntentStore } = await import('../intents/store.ts')
      await new IntentStore().resolve(a.intent ?? '', a.outcome ?? '', a.score ?? 1.0, a.project ?? '')
      return text({ ok: true })
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/**
 * Build a fully-configured MCP Server (tool list + handlers). Transport-agnostic
 * so both the stdio entry point (below) and the streamable-HTTP entry point
 * (`./http.ts`) can bind their own transport to a fresh instance.
 */
export function createMcpServer (): Server {
  const server = new Server({ name: 'vectors', version: '0.3.0' }, { capabilities: { tools: {}}})
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try {
      return await dispatch(req.params.name, (req.params.arguments ?? {}) as ToolArgs)
    }
    catch (err) {
      return { content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  })
  return server
}

// Running this module as a process (e.g. `bun src/mcp/server.ts`, the wiring in
// .mcp.json) starts the stdio server. Importing it (e.g. from ./http.ts) does not.
if (import.meta.main) {
  await createMcpServer().connect(new StdioServerTransport())
  console.error('[vectors] MCP server ready on stdio')
}
