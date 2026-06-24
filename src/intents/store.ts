/**
 * intents/store — intent memory & resolution tracking, backed by the shared
 * Postgres `intent` / `intent_resolution` tables (the SQLite store of the old
 * Python plugin moved here). It indexes the *conversation*: what a user asks
 * (the intent), how often a similar thing recurred (frequency), the assistant's
 * response, and whether it resolved the intent (outcome).
 *
 * recall() is a FAST, model-free lexical fast-path (exact normalized id + token
 * overlap) so the UserPromptSubmit hook never blocks. Grading prefers a LOCAL
 * Ollama judge when reachable (unless INTENT_NO_JUDGE) and otherwise falls back
 * to a transcript heuristic, so the no-network guarantee holds without Ollama.
 */
import { createHash } from 'node:crypto'
import { q, q1, tx } from '../db/pool.ts'
import { lastExchanges } from '../transcript.ts'
import {
  INTENT_MIN_SCORE,
  INTENT_MAX_TOKENS,
  INTENT_NO_JUDGE,
  OLLAMA_URL,
  OLLAMA_MODEL,
} from '../config.ts'


const RESOLUTION_CAP = 12 // keep at most N resolutions per intent (best + recent)
const EXCERPT_CHARS  = 600 // store short response excerpts, not whole replies

/** Greetings / filler that add no intent signal — dropped during normalize. */
const FILLER = new Set([
  'hi', 'hey', 'hello', 'please', 'pls', 'thanks', 'thank', 'you', 'could',
  'can', 'would', 'will', 'kindly', 'just', 'now', 'ok', 'okay', 'so', 'well',
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'is', 'are', 'do', 'does', 'i',
  'we', 'me', 'my', 'our', 'it', 'this', 'that', 'how', 'what', 'why', 'help',
])
const CODE_FENCE = /```[\s\S]*?```|`[^`]*`/g
const WORD       = /[a-z0-9]+/g

const ACCEPT =
  /\b(thanks|thank you|works|worked|perfect|great|awesome|nice|that fixed|that did it|solved|resolved|exactly|brilliant)\b/i
const REJECT =
  /\b(no|nope|still|doesn'?t work|does not work|didn'?t work|not working|wrong|incorrect|error again|same error|broke|broken|failing|didn'?t help|that'?s not|not what)\b/i

export type Outcome = 'resolved' | 'partial' | 'unresolved' | 'unknown'

export interface RecallMatch {
  intent:           string;
  outcome:          string;
  score:            number;
  response_excerpt: string | null;
}

export interface ResolutionRow {
  response_excerpt: string | null;
  outcome:          string;
  score:            number;
  grader:           string;
}

interface Grade {
  outcome: Outcome;
  score:   number;
  grader:  string;
}

/**
 * Canonicalize a user message into a stable intent key: drop code fences,
 * lowercase, keep word/number tokens, and strip greeting/filler so
 * "Hey, can you reset the dev database please" and "reset dev database" collapse
 * to the same intent.
 */
export function normalizeIntent (text: string): string {
  const lowered = (text || '').replace(CODE_FENCE, ' ').toLowerCase()
  const toks    = (lowered.match(WORD) || []).filter(
    t => !FILLER.has(t) && t.length > 1,
  )
  return toks.join(' ')
}

/** Deterministic intent id: "i" + sha256(normalized) hex truncated to 30. */
export function intentId (normalized: string): string {
  return 'i' + createHash('sha256').update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 30)
}

function jaccard (a: string, b: string): number {
  const sa = new Set(a.split(' ').filter(Boolean))
  const sb = new Set(b.split(' ').filter(Boolean))
  if (sa.size === 0 || sb.size === 0)
    return 0

  let inter = 0
  for (const t of sa)
    if (sb.has(t))
      inter++
  return inter / (sa.size + sb.size - inter)
}

function oneline (text: string | null, limit = 200): string {
  return (text || '').split(/\s+/).filter(Boolean)
    .join(' ')
    .slice(0, limit)
}

/**
 * Score how well `response` answered `intent` using a LOCAL Ollama model.
 * Returns a grade or null when Ollama is unreachable (caller falls back to the
 * heuristic). Never throws.
 */
async function ollamaJudge (intentText: string, response: string): Promise<Grade | null> {
  const prompt =
    "You are grading whether an assistant's RESPONSE resolved the user's " +
    'INTENT. Reply ONLY with JSON {"outcome":"resolved|partial|unresolved","score":0..1}. ' +
    `\n\nINTENT:\n${intentText.slice(0, 1500)}\n\nRESPONSE:\n${response.slice(0, 3000)}`
  const body = { model: OLLAMA_MODEL, prompt, stream: false, format: 'json' }
  try {
    const ac    = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60_000)
    const resp  = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ac.signal,
    }).finally(() => clearTimeout(timer))
    if (!resp.ok)
      return null

    const raw     = (await resp.json()) as { response?: string }
    const data    = JSON.parse(raw.response || '') as { outcome?: string; score?: number }
    const outcome = String(data.outcome || '').toLowerCase()
    if (outcome !== 'resolved' && outcome !== 'partial' && outcome !== 'unresolved')
      return null

    const score = Math.max(0, Math.min(1, Number(data.score ?? 0.5)))
    return { outcome: outcome as Outcome, score, grader: 'llm' }
  }
  catch {
    return null
  }
}

/**
 * Grade a resolution from the transcript without a model: if the user's NEXT
 * message re-asks a semantically similar intent, the answer didn't land; an
 * acceptance phrase confirms success, a rejection phrase confirms failure.
 */
function heuristicGrade (prevUser: string, nextUser: string): Grade {
  const sim    = jaccard(normalizeIntent(prevUser), normalizeIntent(nextUser))
  const accept = ACCEPT.test(nextUser || '')
  const reject = REJECT.test(nextUser || '')
  if (reject || sim >= 0.6 && !accept)
    return { outcome: 'unresolved', score: Math.round(Math.max(0, 0.3 - sim * 0.3) * 1000) / 1000, grader: 'heuristic' }
  if (sim >= 0.35 && !accept)
    return { outcome: 'partial', score: 0.5, grader: 'heuristic' }
  return { outcome: 'resolved', score: accept ? 0.9 : 0.7, grader: 'heuristic' }
}

/**
 * Build a compact, token-bounded context block from a recalled intent: the
 * frequency, the best successful resolution, and one cautionary failure. The
 * header always survives. Returns "" when there is nothing useful to inject.
 */
function renderInjection (
  frequency: number,
  resolutions: ResolutionRow[],
  intentText: string,
  maxTokens: number,
): string {
  const successes       = resolutions.filter(r => r.outcome === 'resolved' || r.outcome === 'partial')
  const failures        = resolutions.filter(r => r.outcome === 'unresolved')
  const lines: string[] = [
    `[intent-memory] You have handled a similar request ${frequency} time(s) before` +
      (resolutions.length ? ` (last known outcome: ${resolutions[0].outcome}).` : '.'),
  ]
  if (successes.length) {
    lines.push('Prior resolution that worked:')
    lines.push(`  - ${oneline(successes[0].response_excerpt)} (${successes[0].outcome}).`)
  }
  if (failures.length) {
    lines.push('Earlier attempt that did NOT resolve it (avoid):')
    lines.push(`  - ${oneline(failures[0].response_excerpt)} (unresolved).`)
  }
  if (!successes.length && !failures.length)
    lines.push(`(No graded resolution yet for: ${oneline(intentText)})`)

  // Keep as many lines as fit the budget; the header is first so it always lands.
  const kept: string[] = []
  let total = 0
  for (const ln of lines) {
    const n = Math.max(1, Math.round(ln.trim().length / 4))
    if (maxTokens > 0 && kept.length > 0 && total + n > maxTokens)
      break
    kept.push(ln)
    total += n
  }
  return kept.join('\n')
}

interface IntentRow {
  id:          string;
  normalized:  string;
  intent_text: string;
  project:     string;
  frequency:   number;
}

type CType = Pick<import('pg').PoolClient, 'query'>

/**
 * Postgres-backed intent memory. `record` upserts the intent (incrementing
 * frequency) and opens a pending resolution row for this turn; the Stop hook
 * later attaches the assistant's reply and grades it. A `response` given up
 * front fills the excerpt immediately. `record` returns the intent id ("" when
 * the message normalizes to nothing).
 */
export class IntentStore {
  async record (
    text: string,
    opts: { project?: string; session?: string; response?: string } = {},
  ): Promise<string> {
    const normalized = normalizeIntent(text)
    if (!normalized)
      return ''

    const iid        = intentId(normalized)
    const project    = opts.project ?? ''
    const session    = opts.session ?? ''
    const intentText = text.trim().slice(0, 500)
    const excerpt    =
      opts.response !== undefined ? opts.response.trim().slice(0, EXCERPT_CHARS) : null

    await tx(async c => {
      const existing = await c.query('SELECT 1 FROM intent WHERE id=$1', [ iid ])
      if (existing.rowCount)
        await c.query(
          'UPDATE intent SET frequency=frequency+1, last_seen=now(), last_session=$1, intent_text=$2 WHERE id=$3',
          [ session, intentText, iid ],
        ); else
        await c.query(
          'INSERT INTO intent (id, normalized, intent_text, project, frequency, first_seen, last_seen, first_session, last_session) ' +
            'VALUES ($1,$2,$3,$4,1,now(),now(),$5,$5)',
          [ iid, normalized, intentText, project, session ],
        )
      await c.query(
        'INSERT INTO intent_resolution (intent_id, session, ts, response_excerpt) VALUES ($1,$2,now(),$3)',
        [ iid, session, excerpt ],
      )

      // Cap resolutions: keep the best N by score, but never trim the newest row
      // (the pending turn the Stop hook will fill and grade).
      const idsRes = await c.query<{ id: string }>(
        'SELECT id FROM intent_resolution WHERE intent_id=$1 ORDER BY score DESC, id DESC',
        [ iid ],
      )
      if (idsRes.rows.length > RESOLUTION_CAP) {
        const newest = await c.query<{ m: string }>(
          'SELECT max(id) AS m FROM intent_resolution WHERE intent_id=$1',
          [ iid ],
        )
        const keep = new Set(idsRes.rows.slice(0, RESOLUTION_CAP).map(r => r.id))
        if (newest.rows[0]?.m != null)
          keep.add(newest.rows[0].m)

        const stale = idsRes.rows.map(r => r.id).filter(id => !keep.has(id))
        if (stale.length)
          await c.query('DELETE FROM intent_resolution WHERE id = ANY($1)', [ stale ])
      }
    })
    return iid
  }

  private async resolutionsFor (iid: string): Promise<ResolutionRow[]> {
    return q<ResolutionRow>(
      'SELECT response_excerpt, outcome, score, grader FROM intent_resolution ' +
        "WHERE intent_id=$1 AND response_excerpt IS NOT NULL AND response_excerpt <> '' " +
        'ORDER BY score DESC, id DESC',
      [ iid ],
    )
  }

  /**
   * Find prior intents similar to `query` — fully model-free: exact normalized
   * id, then lexical token-overlap (Jaccard) over candidate intents fetched by
   * trigram/word overlap. The current project is preferred over global matches;
   * honors INTENT_MIN_SCORE.
   */
  // eslint-disable-next-line complexity -- lexical recall scoring has many guard branches
  async recall (query: string, project = '', topk = 3): Promise<RecallMatch[]> {
    const normalized = normalizeIntent(query)
    if (!normalized)
      return []

    const tokens = normalized.split(' ').filter(Boolean)
    const scores = new Map<string, number>()

    const exact    = intentId(normalized)
    const exactRow = await q1('SELECT 1 FROM intent WHERE id=$1', [ exact ])
    if (exactRow)
      scores.set(exact, 1.0)

    // Lexical candidate pull: any stored intent sharing a word with the query.
    // We score precisely with Jaccard in JS (BM25 sidecar replacement).
    if (tokens.length) {
      const likeOr = tokens.map((_, i) => `normalized ILIKE $${i + 1}`).join(' OR ')
      const params = tokens.map(t => `%${t}%`)
      const cands  = await q<{ id: string; normalized: string }>(
        `SELECT id, normalized FROM intent WHERE ${likeOr} LIMIT 200`,
        params,
      )
      for (const cand of cands) {
        const s = jaccard(normalized, cand.normalized)
        if (s > (scores.get(cand.id) ?? 0))
          scores.set(cand.id, s)
      }
    }

    const ranked = [ ...scores.entries() ]
      .filter(([ , s ]) => s >= INTENT_MIN_SCORE)
      .sort((a, b) => b[1] - a[1])

    // Prefer the current project, then fall back to any project.
    const scopes: Array<string | null>                                  = project ? [ project, null ] : [ null ]
    const picked: Array<{ iid: string; score: number; row: IntentRow }> = []
    const seen                                                          = new Set<string>()
    for (const scope of scopes) {
      for (const [ iid, s ] of ranked) {
        if (seen.has(iid))
          continue

        const row = await q1<IntentRow>('SELECT * FROM intent WHERE id=$1', [ iid ])
        if (!row)
          continue
        if (scope !== null && row.project !== scope)
          continue
        seen.add(iid)
        picked.push({ iid, score: s, row })
        if (picked.length >= topk)
          break
      }
      if (picked.length >= topk)
        break
    }

    const out: RecallMatch[] = []
    for (const p of picked) {
      const res  = await this.resolutionsFor(p.iid)
      const best = res[0] ?? null
      out.push({
        intent:           p.row.intent_text,
        outcome:          best ? best.outcome : 'unknown',
        score:            Math.round(p.score * 1000) / 1000,
        response_excerpt: best ? best.response_excerpt : null,
      })
    }
    return out
  }

  /** The rendered context-injection block for a query, or "" if nothing useful. */
  async recallInjection (query: string, project = '', topk = 3): Promise<string> {
    const normalized = normalizeIntent(query)
    if (!normalized)
      return ''

    const matches = await this.recall(query, project, topk)
    if (!matches.length)
      return ''

    const iid       = intentId(normalizeIntent(matches[0].intent))
    const row       = await q1<IntentRow>('SELECT * FROM intent WHERE id=$1', [ iid ])
    const frequency = row?.frequency ?? 1
    const res       = await this.resolutionsFor(iid)
    return renderInjection(frequency, res, matches[0].intent, INTENT_MAX_TOKENS)
  }

  /**
   * Record an explicit resolution: finalize the most recent (preferably
   * ungraded) resolution of the intent, attaching a response excerpt if the
   * pending row never captured one.
   */
  async resolve (intent: string, outcome: string, score = 1.0, project = ''): Promise<void> {
    const normalized = normalizeIntent(intent)
    if (!normalized)
      return

    const oc: Outcome = ([ 'resolved', 'partial', 'unresolved', 'unknown' ].includes(outcome)
      ? outcome
      : 'unknown') as Outcome
    const iid = intentId(normalized)
    await tx(async c => {
      // Ensure the intent exists so the resolution FK holds.
      await c.query(
        'INSERT INTO intent (id, normalized, intent_text, project, frequency, first_seen, last_seen) ' +
          'VALUES ($1,$2,$3,$4,0,now(),now()) ON CONFLICT (id) DO NOTHING',
        [ iid, normalized, intent.trim().slice(0, 500), project ],
      )
      await this.gradeRow(c, iid, { outcome: oc, score, grader: 'explicit' }, null)
    })
  }

  /** Finalize the latest ungraded resolution row (or insert one) on a client. */
  private async gradeRow (
    c: CType,
    iid: string,
    g: Grade,
    response: string | null,
  ): Promise<void> {
    const cur = c.query.bind(c)
    const row = (
      await cur(
        'SELECT id, response_excerpt FROM intent_resolution WHERE intent_id=$1 ORDER BY graded ASC, id DESC LIMIT 1',
        [ iid ],
      )
    ).rows[0] as { id: string; response_excerpt: string | null } | undefined
    if (!row)
      await cur(
        'INSERT INTO intent_resolution (intent_id, ts, response_excerpt, outcome, score, grader, graded) ' +
          'VALUES ($1,now(),$2,$3,$4,$5,true)',
        [ iid, response ? response.trim().slice(0, EXCERPT_CHARS) : null, g.outcome, g.score, g.grader ],
      ); else {
      let excerpt = row.response_excerpt
      if (response && !excerpt)
        excerpt = response.trim().slice(0, EXCERPT_CHARS)
      await cur(
        'UPDATE intent_resolution SET outcome=$1, score=$2, grader=$3, graded=true, response_excerpt=$4 WHERE id=$5',
        [ g.outcome, g.score, g.grader, excerpt, row.id ],
      )
    }
  }

  private async attachResponse (iid: string, response: string): Promise<void> {
    const row = await q1<{ id: string; response_excerpt: string | null }>(
      'SELECT id, response_excerpt FROM intent_resolution WHERE intent_id=$1 ORDER BY id DESC LIMIT 1',
      [ iid ],
    )
    if (row && !row.response_excerpt)
      await q(
        'UPDATE intent_resolution SET response_excerpt=$1 WHERE id=$2',
        [ response.trim().slice(0, EXCERPT_CHARS), row.id ],
      )
  }

  /**
   * Grade the just-finished exchange from a transcript: attach the latest
   * assistant response to its pending resolution and grade it (Ollama judge if
   * reachable/forced, else heuristic), and also finalize the *previous* user
   * turn's resolution now that its follow-up message is visible. Returns the
   * number of resolutions graded.
   */
  async gradePending (transcriptPath: string): Promise<number> {
    const msgs  = await lastExchanges(transcriptPath, 12)
    const users = msgs.filter(m => m.role === 'user').map(m => m.text)
    let lastAssistant = ''
    for (let i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].role === 'assistant') {
        lastAssistant = msgs[i].text
        break
      }

    let graded = 0

    if (users.length && lastAssistant) {
      const uLast = users[users.length - 1]
      const iid   = intentId(normalizeIntent(uLast))
      let judged: Grade | null = null
      if (!INTENT_NO_JUDGE)
        judged = await ollamaJudge(uLast, lastAssistant)
      if (judged) {
        await tx(c => this.gradeRow(c, iid, judged!, lastAssistant))
        graded++
      }
      else
        await this.attachResponse(iid, lastAssistant)
    }

    if (users.length >= 2) {
      const uPrev   = users[users.length - 2]
      const uNext   = users[users.length - 1]
      const iidPrev = intentId(normalizeIntent(uPrev))
      const already = await q1<{ graded: boolean }>(
        'SELECT graded FROM intent_resolution WHERE intent_id=$1 ORDER BY id DESC LIMIT 1',
        [ iidPrev ],
      )
      if (already && !already.graded) {
        const g = heuristicGrade(uPrev, uNext)
        await tx(c => this.gradeRow(c, iidPrev, g, null))
        graded++
      }
    }

    return graded
  }

  /** Frequency leaderboard: most-recurring intents first. */
  async stats (): Promise<Array<{ intent_text: string; frequency: number }>> {
    return q<{ intent_text: string; frequency: number }>(
      'SELECT intent_text, frequency FROM intent ORDER BY frequency DESC, last_seen DESC LIMIT 25',
    )
  }
}
