/**
 * units — typed semantic units (C1).
 *
 * A chunk has a *kind*: section (headed prose/docs), symbol (code defining a
 * callable), definition (code defining a type/const/...), code (other source),
 * text (plain prose). Tagging each chunk with a `unit_type` lets search filter
 * by kind. Heuristic, language-agnostic, deliberately conservative
 * (unknown → "text"/"code").
 */
import type { ChunkStrategy, UnitType } from '../db/types.ts'


const MARKDOWN_EXT = new Set([ '.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc' ])
const CODE_EXT     = new Set([
  '.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua',
  '.sh', '.css', '.scss', '.sql', '.html', '.vue', '.svelte',
])

// A definition-ish line: optional modifiers, a defining keyword, optional name.
const DEF_RE =
  /^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|pub\s+)*(?<kw>def|function|func|fn|class|interface|type|enum|struct|trait|impl|const|let|var)\b\s*(?<name>[A-Za-z_$][\w$]*)?/m

const SYMBOL_KW = new Set([ 'def', 'function', 'func', 'fn', 'class', 'struct', 'impl', 'trait' ])

const HEADING_RE = /^#{1,6}\s/m

export const KINDS: readonly UnitType[] = [ 'section', 'symbol', 'definition', 'code', 'text' ]

/** Resolve the effective chunking strategy from extension when "auto". */
function strategyFor (rel: string, strategy: ChunkStrategy): 'markdown' | 'code' | 'text' {
  if (strategy !== 'auto')
    return strategy

  const i     = rel.lastIndexOf('.')
  const slash = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
  const ext   = i > slash ? rel.slice(i).toLowerCase() : ''
  if (MARKDOWN_EXT.has(ext))
    return 'markdown'
  if (CODE_EXT.has(ext))
    return 'code'
  return 'text'
}

/**
 * Return the unit_type for a chunk. Conservative: unknown → text/code.
 * Argument order matches the typed task contract (text, relPath).
 */
export function classifyUnit (
  text: string,
  relPath: string,
  strategy: ChunkStrategy = 'auto',
): UnitType {
  const strat = strategyFor(relPath, strategy)
  if (strat === 'markdown')
    return HEADING_RE.test(text ?? '') ? 'section' : 'text'
  if (strat === 'code') {
    const m = DEF_RE.exec(text ?? '')
    if (m)
      return SYMBOL_KW.has(m.groups!.kw!) ? 'symbol' : 'definition'
    return 'code'
  }
  return 'text'
}

/** The first defined symbol/type name in a code chunk, if any. */
export function symbolName (text: string): string | null {
  const m = DEF_RE.exec(text ?? '')
  return m && m.groups?.name ? m.groups.name : null
}
