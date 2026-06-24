/**
 * Chunking: split a source file into embeddable slices using one of the
 * strategies the Python engine supported — markdown (heading-aware), code
 * (line-boundary sliding window), text (char sliding window), or auto (pick by
 * extension). Each produced chunk is tagged with a unit_type for typed search.
 */
import type { ChunkConfig, ChunkStrategy, ProducedChunk } from '../db/types.ts'
import { classifyUnit } from './units.ts'


const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php', '.swift', '.kt', '.scala',
  '.sh', '.bash', '.zsh', '.sql', '.css', '.scss', '.vue', '.svelte',
])
const MD_EXT = new Set([ '.md', '.mdx', '.markdown' ])

function extOf (relPath: string): string {
  const i = relPath.lastIndexOf('.')
  return i >= 0 ? relPath.slice(i).toLowerCase() : ''
}

export function pickStrategy (relPath: string, configured: ChunkStrategy): Exclude<ChunkStrategy, 'auto'> {
  if (configured !== 'auto')
    return configured

  const ext = extOf(relPath)
  if (MD_EXT.has(ext))
    return 'markdown'
  if (CODE_EXT.has(ext))
    return 'code'
  return 'text'
}

// Greedy windowing over an array of line strings, bounded by max_chars with a
//  trailing overlap of `overlapLines` lines carried into the next window.
function windowLines (lines: string[], maxChars: number, overlapLines: number): string[] {
  const out: string[] = []
  let buf: string[] = []
  let size          = 0
  for (const line of lines) {
    if (size + line.length > maxChars && buf.length) {
      out.push(buf.join('\n'))
      buf = overlapLines > 0 ? buf.slice(-overlapLines) : []
      size = buf.reduce((s, l) => s + l.length, 0)
    }
    buf.push(line)
    size += line.length
  }
  if (buf.length)
    out.push(buf.join('\n'))
  return out
}

/** Char sliding window with overlap (plain text). */
function windowChars (text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = []
  const step          = Math.max(1, maxChars - overlap)
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + maxChars))
    if (i + maxChars >= text.length)
      break
  }
  return out.length ? out : [ text ]
}

/** Markdown: break at heading boundaries, then overflow large sections by paragraph. */
function chunkMarkdown (text: string, cfg: ChunkConfig): Array<{ title: string | null; body: string }> {
  const lines                                                   = text.split('\n')
  const sections: Array<{ title: string | null; body: string }> = []
  let title: string | null = null
  let buf: string[]        = []
  const flush = () => {
    const body = buf.join('\n').trim()
    if (body)
      sections.push({ title, body })
    buf = []
  }
  for (const line of lines) {
    const m = (/^(#{1,6})\s+(.*)$/).exec(line)
    if (m) {
      flush()
      title = m[2].trim()
    }
    buf.push(line)
  }
  flush()

  // Overflow: split oversized sections into paragraph windows.
  const out: Array<{ title: string | null; body: string }> = []
  for (const sec of sections) {
    if (sec.body.length <= cfg.max_chars) {
      out.push(sec)
      continue
    }

    const paras = sec.body.split(/\n{2,}/)
    let acc: string[] = []
    let size          = 0
    const emit = () => {
      const body = acc.join('\n\n').trim()
      if (body)
        out.push({ title: sec.title, body })
      acc = []
      size = 0
    }
    for (const p of paras) {
      if (size + p.length > cfg.max_chars && acc.length)
        emit()
      acc.push(p)
      size += p.length
    }
    emit()
  }
  return out
}

/**
 * Produce chunks for one file. `context_prefix` prepends the section/file title
 * to the embedded text so isolated chunks keep their context (as the Python did).
 */
export function chunkFile (relPath: string, text: string, cfg: ChunkConfig): ProducedChunk[] {
  const strategy                                           = pickStrategy(relPath, cfg.strategy)
  const raw: Array<{ title: string | null; body: string }> = []

  if (strategy === 'markdown')
    raw.push(...chunkMarkdown(text, cfg)); else if (strategy === 'code')
    for (const body of windowLines(text.split('\n'), cfg.max_chars, Math.ceil(cfg.overlap / 40)))
      raw.push({ title: relPath, body }); else
    for (const body of windowChars(text, cfg.max_chars, cfg.overlap))
      raw.push({ title: relPath, body })

  const chunks: ProducedChunk[] = []
  let ordinal = 0
  for (const { title, body } of raw) {
    const trimmed = body.trim()
    if (trimmed.length < cfg.min_chars && raw.length > 1)
      continue // skip tiny fragments

    const embedText =
      cfg.context_prefix && title && !trimmed.startsWith(title)
        ? `${title}\n\n${trimmed}`
        : trimmed
    chunks.push({
      ordinal:   ordinal++,
      title,
      text:      embedText,
      url:       null,
      unit_type: classifyUnit(embedText, relPath),
    })
  }
  return chunks
}
