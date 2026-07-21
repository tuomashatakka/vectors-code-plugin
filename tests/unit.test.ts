/**
 * Pure-logic unit tests (no DB, no model). Run: bun test
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chunkFile } from '../src/chunk/chunker.ts'
import { classifyUnit } from '../src/chunk/units.ts'
import { confidenceTier, verifyClaim } from '../src/search/grounding.ts'
import { assembleWithinBudget } from '../src/search/assemble.ts'
import { defaultProjectName } from '../src/manifest.ts'
import { isMachineText, parsePromptHistory, parseTranscript } from '../src/transcript.ts'
import { gitIgnored } from '../src/db/ingest.ts'
import { DEFAULT_CHUNK_CONFIG, type SearchHit } from '../src/db/types.ts'
import pkg from '../package.json' with { type: 'json' }
import plugin from '../.claude-plugin/plugin.json' with { type: 'json' }

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

describe('manifest', () => {
  async function inTmpDir (files: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'vectors-test-'))
    try {
      for (const [ name, text ] of Object.entries(files))
        await writeFile(join(dir, name), text)
      await run(dir)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test('package.json name wins, scope stripped', () =>
    inTmpDir({ 'package.json': '{"name":"@scope/pkg"}' }, async dir => {
      expect(await defaultProjectName(dir)).toBe('pkg')
    }))

  test('Cargo.toml [package] name', () =>
    inTmpDir({ 'Cargo.toml': '[package]\nname = "crate-name"\nversion = "0.1.0"\n\n[dependencies]\nname = "decoy"' }, async dir => {
      expect(await defaultProjectName(dir)).toBe('crate-name')
    }))

  test('falls back to the directory basename', () =>
    inTmpDir({}, async dir => {
      expect(await defaultProjectName(dir)).toBe(basename(dir))
    }))

  test('malformed manifest falls through', () =>
    inTmpDir({ 'package.json': 'not json{{' }, async dir => {
      expect(await defaultProjectName(dir)).toBe(basename(dir))
    }))
})

describe('prompt history', () => {
  test('keeps real prompts, skips noise, strips NUL', async () => {
    const dir  = await mkdtemp(join(tmpdir(), 'vectors-test-'))
    const file = join(dir, 'history.jsonl')
    const lines = [
      JSON.stringify({ display: 'fix the login bug', timestamp: 1700000000000, project: '/abs/app', sessionId: 's1' }),
      JSON.stringify({ display: '/ide ', timestamp: 1700000000001, project: '/abs/app', sessionId: 's1' }),
      JSON.stringify({ display: '   ', timestamp: 1700000000002, project: '/abs/app', sessionId: 's1' }),
      JSON.stringify({ display: 'null\x00byte prompt', timestamp: 1700000000003, project: '/abs/app', sessionId: 's1' }),
      'not json at all',
      JSON.stringify({ display: 'no meta fields' }),
    ]
    await writeFile(file, lines.join('\n') + '\n')
    try {
      const entries = await parsePromptHistory(file)
      expect(entries.map(e => e.text)).toEqual([ 'fix the login bug', 'nullbyte prompt', 'no meta fields' ])
      expect(entries[0].project).toBe('/abs/app')
      expect(entries[0].ts).toBe(1700000000000)
      expect(entries[2].project).toBeNull()
      expect(entries[2].ts).toBeNull()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('missing file yields empty', async () => {
    expect(await parsePromptHistory('/nonexistent/history.jsonl')).toEqual([])
  })
})

describe('transcript formats', () => {
  async function withFile (name: string, body: string, fn: (p: string) => Promise<void>): Promise<void> {
    const dir  = await mkdtemp(join(tmpdir(), 'vectors-test-'))
    const file = join(dir, name)
    await writeFile(file, body)
    try {
      await fn(file)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test('claude jsonl keeps user/assistant, skips meta lines', async () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'ignore me' }),
      JSON.stringify({ message: { role: 'user', content: 'index this repo' }}),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }}),
      'not json at all',
    ]
    await withFile('t.jsonl', lines.join('\n') + '\n', async file => {
      expect(await parseTranscript(file)).toEqual([
        { role: 'user', text: 'index this repo' },
        { role: 'assistant', text: 'on it' },
      ])
    })
  })

  test('codex rollout unwraps payload and drops the developer preamble', async () => {
    const ev = (role: string, text: string, type = 'input_text') =>
      JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] }})
    const lines = [
      JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { session_id: 's', cwd: '/x' }}),
      ev('developer', '<permissions instructions>\nsandbox'),
      ev('user', 'wire the hooks'),
      JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', total: 12 }}),
      ev('assistant', 'wired', 'output_text'),
    ]
    await withFile('rollout-x.jsonl', lines.join('\n') + '\n', async file => {
      expect(await parseTranscript(file)).toEqual([
        { role: 'user', text: 'wire the hooks' },
        { role: 'assistant', text: 'wired' },
      ])
    })
  })

  test('gemini chat document maps gemini->assistant and drops notices', async () => {
    const doc = {
      sessionId: 's',
      messages:  [
        { type: 'info', content: 'MCP issues detected.' },
        { type: 'user', content: [{ text: 'convert the pdf' }] },
        { type: 'error', content: '[API Error: quota]' },
        { type: 'gemini', content: 'reading main.py' },
        { type: 'gemini', content: '' },
      ],
    }
    // Pretty-printed: line one is a bare `{`, so this must NOT parse as JSONL.
    await withFile('session-x.json', JSON.stringify(doc, null, 2), async file => {
      expect(await parseTranscript(file)).toEqual([
        { role: 'user', text: 'convert the pdf' },
        { role: 'assistant', text: 'reading main.py' },
      ])
    })
  })

  test('minified gemini chat is still read as a document, not a jsonl record', async () => {
    const doc = { messages: [{ type: 'user', content: 'hi' }] }
    await withFile('session-min.json', JSON.stringify(doc), async file => {
      expect(await parseTranscript(file)).toEqual([ { role: 'user', text: 'hi' } ])
    })
  })

  test('missing file yields empty', async () => {
    expect(await parseTranscript('/nonexistent/transcript.jsonl')).toEqual([])
  })

  test('machine text covers the codex-injected user turns', () => {
    for (const t of [
      '<recommended_plugins>\nhere is a list',
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>',
      '<permissions instructions>\nFilesystem sandboxing',
      '<environment_context>\ncwd',
      '<system-reminder>stale',
    ])
      expect(isMachineText(t)).toBe(true)
    expect(isMachineText('wire the hooks into codex')).toBe(false)
  })
})

describe('gitignore filter', () => {
  test('flags ignored paths and keeps tracked ones', async () => {
    const repoRoot = join(import.meta.dir, '..')
    const ignored  = await gitIgnored(repoRoot, [ 'node_modules/x.ts', 'src/config.ts' ])
    expect(ignored.has('node_modules/x.ts')).toBe(true)
    expect(ignored.has('src/config.ts')).toBe(false)
  })

  test('degrades to empty outside a work tree', async () => {
    expect((await gitIgnored(tmpdir(), [ 'a.txt' ])).size).toBe(0)
  })
})

describe('versions', () => {
  test('plugin.json stays in lockstep with package.json', () => {
    expect(plugin.version).toBe(pkg.version)
  })
})
