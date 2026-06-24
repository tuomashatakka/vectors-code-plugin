/**
 * Pure-logic unit tests (no DB, no model). Run: bun test
 */
import { describe, expect, test } from 'bun:test'
import { chunkFile } from '../src/chunk/chunker.ts'
import { classifyUnit } from '../src/chunk/units.ts'
import { confidenceTier, verifyClaim } from '../src/search/grounding.ts'
import { assembleWithinBudget } from '../src/search/assemble.ts'
import { DEFAULT_CHUNK_CONFIG, type SearchHit } from '../src/db/types.ts'

function hit (over: Partial<SearchHit>): SearchHit {
  return {
    chunk_id: 'c', document_id: 'd', project: 'p', ordinal: 0, title: null,
    text: 'x', url: null, unit_type: 'text', dense: 0, sparse: 0, rrf: 0, score: 0, ...over,
  }
}

describe('chunker', () => {
  test('markdown splits at headings', () => {
    const md = '# Title\n\nIntro paragraph about pgvector.\n\n## Section\n\nMore body text here that is reasonably long.'
    const chunks = chunkFile('doc.md', md, { ...DEFAULT_CHUNK_CONFIG, min_chars: 1 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0].ordinal).toBe(0)
  })

  test('auto strategy picks code for .ts files', () => {
    const code = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i}`).join('\n')
    const chunks = chunkFile('mod.ts', code, { ...DEFAULT_CHUNK_CONFIG, max_chars: 200, min_chars: 1 })
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('units', () => {
  const KINDS = ['section', 'symbol', 'definition', 'code', 'text']
  test('classifies a markdown heading as section', () => {
    expect(classifyUnit('# Overview\n\nsome prose', 'guide.md')).toBe('section')
  })
  test('always returns a valid unit type', () => {
    expect(KINDS).toContain(classifyUnit('plain prose', 'notes.txt'))
  })
  test('classifies code text', () => {
    expect(['code', 'symbol', 'definition']).toContain(classifyUnit('function foo () { return 1 }', 'a.ts'))
  })
})

describe('grounding', () => {
  test('confidenceTier is low on empty', () => {
    expect(confidenceTier([])).toBe('low')
  })
  test('confidenceTier high when reranked score is strong', () => {
    expect(confidenceTier([hit({ rerank: 6, dense: 0.9, sparse: 0.5 })])).toBe('high')
  })
  test('verifyClaim supports a lexically-grounded claim', () => {
    const r = verifyClaim('pgvector stores embeddings', ['pgvector stores embeddings in postgres'])
    expect(r.supported).toBe(true)
    expect(r.source_index).toBe(0)
  })
  test('verifyClaim rejects an unsupported claim', () => {
    expect(verifyClaim('bananas potassium fruit', ['postgres vector index']).supported).toBe(false)
  })
})

describe('assemble', () => {
  test('keeps hits within a token budget', () => {
    const hits = Array.from({ length: 20 }, (_, i) => hit({ chunk_id: `c${i}`, text: 'word '.repeat(100), score: 20 - i }))
    const kept = assembleWithinBudget(hits, 200)
    expect(kept.length).toBeLessThan(hits.length)
    expect(kept.length).toBeGreaterThan(0)
  })
})
