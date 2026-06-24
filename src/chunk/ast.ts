/**
 * AST-aware code chunking + a lightweight symbol graph, via tree-sitter (WASM).
 *
 * astChunks() turns a source file into one chunk per named declaration
 * (function/method → 'symbol'; class/interface/type/enum/struct/const →
 * 'definition'), titled by the symbol name — far better retrieval granularity
 * than blind line windows. astImports() extracts module paths for the graph.
 *
 * Everything degrades gracefully: an unsupported language or a parse failure
 * returns null so the caller falls back to the line-window chunker.
 */
import { Parser, Language } from 'web-tree-sitter'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import type { ProducedChunk, ChunkConfig, UnitType } from '../db/types.ts'


const HERE     = dirname(fileURLToPath(import.meta.url)) // src/chunk
const WASM_DIR = join(HERE, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out')

/** File extension → tree-sitter grammar basename (must exist in tree-sitter-wasms/out). */
const GRAMMAR: Record<string, string> = {
  '.ts':    'typescript',
  '.mts':   'typescript',
  '.cts':   'typescript',
  '.tsx':   'tsx',
  '.js':    'javascript',
  '.jsx':   'javascript',
  '.mjs':   'javascript',
  '.cjs':   'javascript',
  '.py':    'python',
  '.go':    'go',
  '.rs':    'rust',
  '.java':  'java',
  '.c':     'c',
  '.h':     'c',
  '.cpp':   'cpp',
  '.hpp':   'cpp',
  '.cc':    'cpp',
  '.cxx':   'cpp',
  '.rb':    'ruby',
  '.php':   'php',
  '.cs':    'c_sharp',
  '.swift': 'swift',
  '.kt':    'kotlin',
  '.scala': 'scala',
  '.lua':   'lua',
}

// Node types that name a callable (→ 'symbol') vs. a type/value definition (→ 'definition').
const CALLABLE = new Set([ 'function_declaration', 'function_definition', 'function_item', 'method_definition', 'method_declaration', 'constructor_declaration' ])
const TYPEDEF  = new Set([ 'class_declaration', 'class_definition', 'interface_declaration', 'type_alias_declaration', 'type_declaration', 'enum_declaration', 'struct_item', 'enum_item', 'trait_item', 'impl_item', 'module' ])
const VALUEDEF = new Set([ 'lexical_declaration', 'const_item', 'const_declaration' ])
// Wrappers to unwrap when scanning top-level statements.
const UNWRAP   = new Set([ 'export_statement', 'decorated_definition', 'ambient_declaration', 'declaration' ])
// Import-ish statements whose string children are module paths.
const IMPORTS  = new Set([ 'import_statement', 'import_from_statement', 'import_declaration', 'use_declaration', 'require_call' ])

let initialized = false
const parsers = new Map<string, Parser | null>()

function extOf (relPath: string): string {
  const i = relPath.lastIndexOf('.')
  return i >= 0 ? relPath.slice(i).toLowerCase() : ''
}

export function astLanguageFor (relPath: string): string | undefined {
  const g = GRAMMAR[extOf(relPath)]
  return g && existsSync(join(WASM_DIR, `tree-sitter-${g}.wasm`)) ? g : undefined
}

async function parserFor (grammar: string): Promise<Parser | null> {
  if (parsers.has(grammar))
    return parsers.get(grammar)!
  if (!initialized) {
    await Parser.init()
    initialized = true
  }
  try {
    const lang   = await Language.load(join(WASM_DIR, `tree-sitter-${grammar}.wasm`))
    const parser = new Parser()
    parser.setLanguage(lang)
    parsers.set(grammar, parser)
    return parser
  }
  catch {
    parsers.set(grammar, null)
    return null
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- tree-sitter Node is loosely typed */
function unwrap (node: any): any {
  let n = node
  while (n && UNWRAP.has(n.type) && n.namedChildCount) {
    const inner = childrenOf(n).find(c => CALLABLE.has(c.type) || TYPEDEF.has(c.type) || VALUEDEF.has(c.type))
    if (!inner)
      break
    n = inner
  }
  return n
}

function childrenOf (node: any): any[] {
  const out: any[] = []
  for (let i = 0; i < node.namedChildCount; i++)
    out.push(node.namedChild(i))
  return out
}

function nameOf (node: any): string | null {
  const f = node.childForFieldName?.('name')
  if (f?.text)
    return f.text
  for (const c of childrenOf(node)) {
    if ((/identifier$/).test(c.type))
      return c.text
    if (c.type === 'variable_declarator') {
      const n = c.childForFieldName?.('name')
      if (n?.text)
        return n.text
    }
  }
  return null
}

function kindOf (type: string): UnitType | null {
  if (CALLABLE.has(type))
    return 'symbol'
  if (TYPEDEF.has(type) || VALUEDEF.has(type))
    return 'definition'
  return null
}

/** AST chunks for a code file, or null if the language is unsupported / unparseable. */
export async function astChunks (relPath: string, text: string, cfg: ChunkConfig): Promise<ProducedChunk[] | null> {
  const grammar = astLanguageFor(relPath)
  if (!grammar)
    return null

  const parser = await parserFor(grammar)
  if (!parser)
    return null

  let tree
  try {
    tree = parser.parse(text)
  }
  catch {
    return null
  }
  if (!tree?.rootNode)
    return null

  const tops                    = childrenOf(tree.rootNode)
  const minChas                 = tops.length > 1 ? cfg.min_chars : 0
  const chunks: ProducedChunk[] = []
  for (const child of tops) {
    const c = toChunk(unwrap(child), relPath, cfg, minChas, chunks.length)
    if (c)
      chunks.push(c)
  }
  tree?.delete?.()
  return chunks.length ? chunks : null
}


function toChunk (node: any, relPath: string, cfg: ChunkConfig, minChars: number, ordinal: number): ProducedChunk | null {
  const kind = kindOf(node.type)
  if (!kind)
    return null

  const body = node.text as string
  if (body.trim().length < minChars)
    return null

  const symbol = nameOf(node)
  const title  = symbol ? `${relPath} › ${symbol}` : relPath
  const text   = cfg.context_prefix ? `${title}\n\n${body}` : body
  return { ordinal, title, text, url: null, unit_type: kind, symbol }
}

/** Module paths imported by a code file (best-effort; for the symbol graph). */
export async function astImports (relPath: string, text: string): Promise<string[]> {
  const grammar = astLanguageFor(relPath)
  if (!grammar)
    return []

  const parser = await parserFor(grammar)
  if (!parser)
    return []

  let tree
  try {
    tree = parser.parse(text)
  }
  catch {
    return []
  }

  const out   = new Set<string>()
  const visit = (node: any): void => {
    if (IMPORTS.has(node.type))
      for (const c of childrenOf(node))
        if (c.type === 'string' || c.type === 'string_literal' || c.type === 'interpreted_string_literal')
          out.add(c.text.replace(/^['"`]|['"`]$/g, ''))
    for (const c of childrenOf(node))
      visit(c)
  }
  visit(tree!.rootNode)
  tree?.delete?.()
  return [ ...out ]
}
/* eslint-enable @typescript-eslint/no-explicit-any */
