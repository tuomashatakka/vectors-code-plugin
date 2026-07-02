# vectors-plugin — Specification

> **Source of truth.** This document specifies the entire system in enough
> detail to rebuild it. It reflects the TypeScript-on-Bun implementation backed
> by PostgreSQL + pgvector. There is **no Python**: embeddings and reranking are
> pure JS/WASM via `@xenova/transformers` (ONNX); AST chunking uses
> `web-tree-sitter` + `tree-sitter-wasms`.

---

## 1. Overview & philosophy

`vectors-plugin` is a **global, local, project-partitioned semantic RAG store**.
One PostgreSQL database holds many **projects**; each project is its own
embedded + cross-encoder-reranked index. The active project is **auto-resolved
from the working directory**, so an agent inside a repo gets that repo's
retrieval for free. You can also search **globally** across every project, with
the merged hits reranked so they are comparable even across embedding models.

Principles:

- **Local-first, offline at query time.** Embedding (`all-MiniLM-L6-v2`, 384-d)
  and reranking (`cross-encoder/ms-marco-MiniLM-L6-v2`) run on-device. No API
  keys; no network when you query. Models cache under `~/.cache/huggingface` on
  first use.
- **Project is the first-class key**, resolved from cwd — you rarely name it.
- **Hybrid retrieval, grounded.** Dense (pgvector cosine) + sparse (Postgres
  FTS) fused with RRF, cross-encoder reranked, with a confidence tier, signal
  agreement, and citation/grounding validation against the corpus.
- **One unified store.** Chunk vectors, chat history, external references, a
  4-level memory ladder, a learning fact store, an intent memory, and a
  background digest queue all live in one Postgres DB and cross-reference via a
  polymorphic `link` table.
- **No build step.** `bun src/cli/index.ts …` runs the TypeScript directly.

```
VINDEX_DSN  →  one PostgreSQL + pgvector database
   project: scene        own documents/chunks/vectors, rooted at a dir/repo
   project: portfolio
   project: rustbook

per-project   files → chunk → embed → store        (ingest, incremental)
              query → embed → dense+sparse → RRF → rerank   (search, offline)
global        fan out across projects → merge → one rerank → tagged hits
```

---

## 2. Data model

PostgreSQL 16 + pgvector ≥ 0.7. Full DDL: `references/unified-knowledge-db.sql`.
Applied once by `applySchema()` (guarded on `embedding_space` existing), then
`migrate()` adds idempotent columns/indexes. Extensions: `pgcrypto`
(`gen_random_uuid()`), `vector` (pgvector), `pg_trgm` (trigram on `uri`).

### 2.1 Enums

| Enum | Values | Purpose |
| --- | --- | --- |
| `node_kind` | `chunk, message, memory, reference, fact, summary` | What a polymorphic `(kind,id)` points at. |
| `mem_level` | `L0, L1, L2, L3` | The memory abstraction ladder (L0 verbatim → L3 vaguest). |
| `link_kind` | `sibling, related, cites, derived_from, mentions, duplicate_of, parent_child` | Cross-reference relationship semantics. |
| `job_state` | `queued, leased, done, failed, dead` | Digest-job lifecycle. |
| `ref_kind` | `url, gdrive, notion, github, citation, file` | External-reference flavours. |

### 2.2 `embedding_space` + per-space vector tables

pgvector columns are fixed-dimension and HNSW only indexes a fixed-dim column,
but the embed model (hence dim) varies per project. Each distinct
`(model, dim, metric)` is one **space** backed by its own physical
`emb_<name>` table. Everything with a vector references it indirectly via
`(space_id, embedding_id)`. Most installs have exactly one space (MiniLM/384).

```sql
CREATE TABLE embedding_space (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model       text NOT NULL,
  dim         integer NOT NULL,
  metric      text NOT NULL DEFAULT 'cosine',   -- cosine | ip | l2
  table_name  text NOT NULL,                     -- physical table, e.g. 'emb_minilm_384'
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, dim, metric)
);
```

The default-space instance (created by the DDL):

```sql
CREATE TABLE emb_minilm_384 (
  embedding_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      uuid NOT NULL REFERENCES embedding_space(id),
  content_hash  bytea NOT NULL,                  -- sha256 of the embedded text
  token_count   integer,
  embedding     vector(384) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, content_hash)                -- de-dupes identical text in a space
);
CREATE INDEX emb_minilm_384_hnsw ON emb_minilm_384
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

Embeddings are L2-normalized at ingest, so **cosine == inner product**.
`content_hash` de-dupes: a chunk and a verbatim message with the same text share
one vector row. The physical table name is derived by `spaceTableName(model,dim)`:
`all-MiniLM-L6-v2`/384 → `emb_minilm_384`; any other model →
`emb_<slug>_<dim>` (lowercased, non-alphanumerics → `_`). New spaces get a
matching HNSW index built with the metric's opclass (`vector_cosine_ops` /
`vector_ip_ops` / `vector_l2_ops`).

### 2.3 `project`

```sql
CREATE TABLE project (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,
  parent_id     uuid REFERENCES project(id) ON DELETE SET NULL,  -- hierarchy
  root_path     text,                              -- anchor for cwd auto-resolution
  embed_model   text NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  rerank_model  text NOT NULL DEFAULT 'cross-encoder/ms-marco-MiniLM-L6-v2',
  space_id      uuid NOT NULL REFERENCES embedding_space(id),
  chunk_cfg     jsonb NOT NULL DEFAULT
                  '{"strategy":"auto","min_chars":200,"max_chars":1500,"overlap":150}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- migrate() adds:  sources jsonb NOT NULL DEFAULT '[]'
```

`sources` (added by `migrate()`) is the per-project ingest source list (replaces
the old per-project `config.json`). Each entry is a `SourceConfig`:

```jsonc
{ "id": "code", "type": "dir", "path": "/abs/path",
  "globs": ["**/*.ts", "**/*.md"], "base_url": "https://…/{path}" }
```

`type` ∈ `dir | repo`; `base_url` is a URL template where `{path}` is replaced
by the file path relative to the source root (or appended if `{path}` absent).

### 2.4 `document` + `chunk` (own content)

```sql
CREATE TABLE document (
  id, project_id, source_id text, rel_path text, title, url,
  content text, content_hash bytea, mtime timestamptz, created_at,
  UNIQUE (project_id, source_id, rel_path)
);
CREATE TABLE chunk (
  id uuid PK, document_id, project_id (denormalized),
  ordinal integer, title, text NOT NULL, url, content_hash bytea,
  token_count, space_id, embedding_id uuid,  -- nullable: feeders insert raw, embed job fills it
  created_at,
  UNIQUE (document_id, ordinal)
);
-- migrate() adds to chunk:  unit_type text, symbol text, tsv tsvector (generated)
```

`migrate()` adds, on `chunk`:

- `unit_type text` — typed unit (`section|symbol|definition|code|text`).
- `symbol text` — the symbol name for AST chunks (`chunk_symbol_idx` partial).
- `tsv tsvector` — `GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || text)) STORED`, with a GIN index (`chunk_tsv_idx`) powering the **sparse** leg.

Re-ingest UPSERTs by `UNIQUE (document_id, ordinal)`; whole-file `content_hash`
on `document` lets unchanged files be skipped.

### 2.5 Chat memory: `session` + `message`

`session(id, project_id, title, started_at, ended_at)`.
`message(id, session_id, project_id, role, seq, text, content_hash, token_count, space_id, embedding_id, created_at, UNIQUE(session_id, seq))`. A raw message
is an L0 node like a chunk; `embedding_id` is nullable until the digest worker
embeds it.

### 2.6 `reference` (external references)

Global (not project-scoped): the same URL/Notion page can be cited from many
projects. `reference(id, kind ref_kind, uri text, title, snippet, content_hash, metadata jsonb, space_id, embedding_id, first_seen, last_seen, UNIQUE(kind, uri))`,
with `reference_uri_trgm` GIN trigram index. **`uri` is app-capped to ≤ 2048
chars** before insert — a longer match is a minified line/blob, not a real
reference, and would overflow the btree unique index (~2704-byte limit).
Ingestion's import graph writes `reference(kind='file')` rows.

### 2.7 `fact` (constantly-learning memory + salience decay)

```sql
CREATE TABLE fact (
  id, project_id (NULL = global/user-level), fact_type text,  -- fact|preference|decision|entity
  statement text, content_hash bytea, confidence real DEFAULT 0.5,
  salience real DEFAULT 0.5, hit_count integer DEFAULT 0, last_used_at,
  space_id, embedding_id, status text DEFAULT 'active',       -- active|superseded|retracted
  created_at, updated_at, UNIQUE (project_id, content_hash)
);
CREATE INDEX fact_salience_idx ON fact (project_id, status, salience DESC);
```

Decay is **computed, not a destructive rewrite**:

```
effective_salience = salience * exp(-lambda * age) + beta * ln(1 + hit_count)
```

Reuse bumps `hit_count` / `salience`; near-duplicates are collapsed via
`duplicate_of` links and `status='superseded'`, never hard-deleted.

### 2.8 Memory abstraction ladder L0–L3: `memory_node` + `derivation`

The exactness ladder:

- **L0** — exact content, anchored to a `chunk` or `message` (verbatim, no summary).
- **L1** — per-document / per-exchange summary.
- **L2** — topic / cluster.
- **L3** — vague concept / theme (top, vaguest).

```sql
CREATE TABLE memory_node (
  id, project_id (NULL = cross-project), level mem_level NOT NULL,
  anchor_kind node_kind, anchor_id uuid,   -- L0 anchors to exact content
  summary text, label text,                -- L1+ derived prose / topic name
  content_hash bytea NOT NULL, token_count, space_id, embedding_id,
  version integer DEFAULT 1, is_stale boolean DEFAULT false,
  source_fingerprint bytea,                -- hash of the set of child hashes built from
  generator text, generated_at, created_at,
  CHECK ((level = 'L0') = (anchor_id IS NOT NULL))   -- L0 <=> anchored
);
CREATE TABLE derivation (
  parent_id uuid REFERENCES memory_node(id) ON DELETE CASCADE,  -- higher/derived
  child_id  uuid REFERENCES memory_node(id) ON DELETE CASCADE,  -- lower/source
  child_hash bytea NOT NULL,                -- freezes child content_hash at build time
  PRIMARY KEY (parent_id, child_id)
);
```

Higher levels are **derived** by a local model from lower nodes via the
`derivation` DAG. `derivation.child_hash` freezes the child's `content_hash` at
build time; `source_fingerprint` (hash of sorted child hashes) + `is_stale` +
`version` let staleness propagate up and trigger bottom-up regeneration. **Raw L0
content is never mutated by a rebuild** — the headline decoupling guarantee.

### 2.9 `link` (polymorphic cross-references)

One polymorphic table over typed join tables (the requirement is open-ended,
N-way, and cross-project). `project_id NULL` = cross-project link.

```sql
CREATE TABLE link (
  id, src_kind node_kind, src_id uuid, dst_kind node_kind, dst_id uuid,
  relation link_kind NOT NULL, weight real DEFAULT 1.0,
  project_id uuid (NULL = cross-project), metadata jsonb DEFAULT '{}', created_at,
  UNIQUE (src_kind, src_id, dst_kind, dst_id, relation)
);
-- indexes: link_src_idx(src_kind,src_id,relation), link_dst_idx(dst_kind,dst_id,relation),
--          link_src_idx(src_kind,src_id) [added by migrate()]
```

The abstraction DAG keeps its own `derivation` table (it additionally stores
`child_hash`); `link` covers everything else and surfaces cross-references at
retrieval.

### 2.10 Digest job queue: `digest_job` + triggers

```sql
CREATE TABLE digest_job (
  id bigint GENERATED ALWAYS AS IDENTITY PK, task text, payload jsonb,
  priority integer DEFAULT 100,             -- lower = sooner
  state job_state DEFAULT 'queued', dedupe_key text UNIQUE,
  attempts integer DEFAULT 0, max_attempts integer DEFAULT 5,
  lease_until timestamptz, last_error text, result jsonb, created_at, updated_at
);
CREATE INDEX job_ready_idx ON digest_job (priority, id) WHERE state = 'queued';
```

Task catalog (all "haiku-level", on local Ollama): `embed`, `summarize`,
`extract_concepts`, `cluster_topics`, `extract_references`, `extract_facts`,
`dedupe`, `rebuild_abstraction`. `payload` carries ids, never blobs.

`AFTER INSERT` triggers on `chunk`, `message`, `reference` call
`enqueue_digest(kind)` which inserts an `embed` job (`dedupe_key =
'embed:'||kind||':'||id`, `ON CONFLICT DO NOTHING`) and `pg_notify('digest', …)`.
NOTIFY is fire-and-forget (the optimizer); `job_ready_idx` polling is the source
of truth. The worker claim is safe for many workers:

```sql
UPDATE digest_job SET state='leased', attempts=attempts+1,
       lease_until = now() + interval '5 min', updated_at = now()
WHERE id = (SELECT id FROM digest_job WHERE state='queued'
            ORDER BY priority, id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

A reaper requeues rows whose `lease_until < now()` (crashed workers).

### 2.11 `daemon_state`

`daemon_state(key text PK, value jsonb DEFAULT '{}', updated_at)` — watermark
KV for feeders (chat per-file offsets `chat:<file>` = `{sessionId, seq}`; source
scan times `source:<project>` = `{lastScan}`).

### 2.12 Intent memory: `intent` + `intent_resolution`

```sql
CREATE TABLE intent (
  id text PRIMARY KEY,            -- "i" + sha256(normalized)[:30]
  normalized text, intent_text text, project text DEFAULT '',  -- '' = global
  frequency integer DEFAULT 0, first_seen, last_seen, first_session, last_session
);
CREATE TABLE intent_resolution (
  id bigserial PK, intent_id text REFERENCES intent(id) ON DELETE CASCADE,
  session, ts timestamptz DEFAULT now(), response_excerpt text,
  outcome text DEFAULT 'unknown' CHECK (outcome IN ('resolved','partial','unresolved','unknown')),
  score real DEFAULT 0.0, grader text DEFAULT '', graded boolean DEFAULT false
);
```

`id` is the deterministic intent id so any external store stays in lockstep.

---

## 3. Embedding spaces & models

- **Embed** (`src/embed/embedder.ts`): `@xenova/transformers`
  `feature-extraction` pipeline, `{ pooling: 'mean', normalize: true }`. Default
  `all-MiniLM-L6-v2` (384-d). Logical sentence-transformers names map to ONNX
  repos via `toXenovaRepo()` (`all-MiniLM-L6-v2` → `Xenova/all-MiniLM-L6-v2`).
  `embed(texts, model)` returns `number[][]`; `embedOne`, `embedDim` (probes once,
  cached) are helpers.
- **Rerank** (`src/embed/rerank.ts`): `AutoTokenizer` +
  `AutoModelForSequenceClassification`. Default
  `cross-encoder/ms-marco-MiniLM-L6-v2` → `Xenova/ms-marco-MiniLM-L-6-v2` via
  `toXenovaReranker()`. `rerank(query, passages, model)` tokenizes
  `(query, passage)` pairs (`text_pair`, padded, truncated) and returns one
  relevance logit per passage (`logits` shape `[n,1]`). `rerankBy` sorts items.
- Both pipelines are cached per repo. Vectors are L2-normalized so cosine ==
  inner product, matching the HNSW opclass.

---

## 4. Chunking

`chunkFile(relPath, text, cfg)` in `src/chunk/chunker.ts` selects a strategy by
`cfg.strategy` (`markdown|code|text|auto`); `auto` resolves by extension:
markdown (`.md/.mdx/.markdown`), code (a large set incl. `.ts/.py/.go/.rs/…`),
else text.

- **markdown** — split at `^#{1,6}\s` heading boundaries into sections; oversized
  sections (> `max_chars`) split further by paragraph windows.
- **code** — greedy line-window (`windowLines`) bounded by `max_chars`, carrying
  `ceil(overlap/40)` lines of overlap.
- **text** — char sliding window (`windowChars`), step `max(1, max_chars-overlap)`.

`ChunkConfig` defaults: `{ strategy:'auto', min_chars:200, max_chars:1500,
overlap:150, context_prefix:true }`. With `context_prefix`, the section/file
title is prepended to the **embedded** text (raw text stored for display) so an
isolated chunk keeps its context. Fragments < `min_chars` are dropped (unless the
file produced only one chunk). Each chunk gets a `unit_type` from
`classifyUnit(text, relPath)`.

### 4.1 `unit_type` classification (`src/chunk/units.ts`)

Conservative, language-agnostic. Kinds: `section` (headed markdown prose),
`symbol` (code defining a callable: `def/function/func/fn/class/struct/impl/
trait`), `definition` (code defining a type/const: `interface/type/enum/const/
let/var`), `code` (other source), `text` (plain prose / unknown). `symbolName()`
returns the first defined name in a code chunk.

### 4.2 AST chunking + symbol graph (headline feature) — `src/chunk/ast.ts`

Code files are chunked by **tree-sitter** into **one chunk per named
declaration**, via `web-tree-sitter` + `tree-sitter-wasms` (pure JS/WASM grammar
WASMs in `node_modules/tree-sitter-wasms/out`). Supported languages (by
extension → grammar): ts/mts/cts, tsx, js/jsx/mjs/cjs, py, go, rust, java,
c/h, cpp/hpp/cc/cxx, ruby, php, c_sharp, swift, kotlin, scala, lua. Unsupported
languages or parse failures **return `null`**, and the caller falls back to the
line-window chunker.

- **`astChunks(relPath, text, cfg)`** scans top-level statements (unwrapping
  `export_statement`/`decorated_definition`/etc.), and for each named
  declaration emits a `ProducedChunk`:
  - functions/methods/constructors → `unit_type='symbol'`.
  - classes/interfaces/types/enums/structs/traits/impls/modules/consts →
    `unit_type='definition'`.
  - `title = "<relPath> › <symbol>"`; `symbol` = the declaration name;
    `text` is the body (prefixed by the title when `context_prefix`).
  - Bodies shorter than `min_chars` are skipped when a file has > 1 top node.
- **`astImports(relPath, text)`** extracts module paths from import-ish nodes
  (`import_statement`, `import_from_statement`, `import_declaration`,
  `use_declaration`, `require_call`) — best-effort, for the import graph.

Example: a TS file with `export function foo(){…}` and `class Bar{…}` produces
two chunks titled `src/x.ts › foo` (symbol) and `src/x.ts › Bar` (definition),
plus `reference(kind='file')` + `link(relation='mentions')` edges for its
imports (see §6).

---

## 5. Ingestion (`src/db/ingest.ts`)

`ingestProject(name, rebuild=false)`:

1. `assertWritable('ingest')` (honors `VINDEX_READONLY`).
2. Resolve project + its `emb_<space>` table; if `rebuild`, `DELETE FROM
   document WHERE project_id=…` first.
3. For each source (`assertAllowedRoot(source.path)`), list files via `Bun.Glob`
   (fallback `node:fs/promises` glob), sorted.
4. For each file: read UTF-8 (skip unreadable/binary), `sha256` the whole file.
   **Diff-by-hash**: if a `document` row exists with the same `content_hash`,
   skip it (unchanged).
5. Changed file: pick strategy. **Code files** (`pickStrategy(...)==='code'`)
   get `astChunks()`; if it returns null, fall back to `chunkFile()`. Non-code
   uses `chunkFile()`. Imports collected via `astImports()` for code files.
6. **Embed** all chunks for the file in one `embed()` batch.
7. In one transaction: UPSERT `document`
   (`ON CONFLICT (project_id, source_id, rel_path)`), delete its old `chunk`
   rows, then per chunk UPSERT the vector
   (`ON CONFLICT (space_id, content_hash)` — **dedup within space**) and the
   `chunk` row (`ON CONFLICT (document_id, ordinal)`), storing `unit_type` and
   `symbol`.
8. **Import graph edges**: for each imported module path, UPSERT a
   `reference(kind='file', uri=path)` and a
   `link(src_kind='chunk', src_id=<first chunk>, dst_kind='reference',
   relation='mentions', project_id)`. This is the **import graph**.

`reindexProject(name)` = `ingestProject(name, true)`. Returns `IngestStats {
project, filesScanned, filesChanged, chunks }`. Token counts are estimated
`~len/4`.

---

## 6. Hybrid retrieval (`src/search/search.ts`)

Two legs fused with **Reciprocal Rank Fusion** (`RRF_K = 60`), then optional
cross-encoder rerank.

- **Dense leg** — pgvector cosine ANN over the project's `emb_<space>` table:
  `1 - (e.embedding <=> $q)` similarity, `ORDER BY e.embedding <=> $q LIMIT
  fetchK`, joined to embedded chunks.
- **Sparse leg** — Postgres FTS: `ts_rank(c.tsv, websearch_to_tsquery('english',
  $q))`, `WHERE c.tsv @@ websearch_to_tsquery(...)`.
- **Fusion** — per hit, `rrf += 1/(RRF_K + rank + 1)` for each leg it appears in;
  `score = rrf`.
- **Rerank** (`finalize`) — when enabled and >1 hit: take `max(topk*3, topk)`
  top-RRF hits, cross-encoder score them, set `score = rerank`, re-sort, slice to
  `topk`.
- **Confidence tier** (`src/search/grounding.ts`, `confidenceTier`): from the
  top hit's rerank score (thresholds `4.0` high / `0.0` med) or dense cosine when
  unreranked (`0.55` / `0.40`), plus **signal agreement** (≥2 signals among the
  top 3). Tiers: `high | medium | low`.
- **Agreement** flag: any of the top-3 hits had both dense > 0 and sparse > 0.

`searchProject(query, projectName, {topk=8, rerank=true})` runs the pipeline for
one project (fetchK = `topk*4`). `searchGlobal(query, {topk=8, rerank, projects?})`
fans the pipeline across every project (or a `projects` subset), each per-project
fetching `topk*2`, merges, and applies **one** rerank over the union (so ordering
is comparable across embedding models). Result project field is `'*'`.

`SearchResult = { query, project, hits: SearchHit[], confidence, agreement }`.
`SearchHit` carries `dense`, `sparse`, `rrf`, optional `rerank`, final `score`,
plus `chunk_id, document_id, project, ordinal, title, text, url, unit_type`.

### 6.1 Grounding / citation validation (`src/search/references.ts`, `grounding.ts`)

- `extractReferences(text)` pulls URLs and citation-shaped tokens
  (`number/year`, `CODE 3:9.2`/`RFC 7231`, `§ 36`); over-long (> 2048) matches
  dropped.
- `validateCitations(text, searchFn, opts)` checks each reference against the
  corpus: verified if it appears verbatim in a retrieved chunk, or a top hit
  clears `threshold`. Unverifiable refs are annotated `[UNVERIFIED]`. Returns
  `{ references, verified, unverified, annotated }`.
- `checkGroundedness(text, corpus)` wraps `validateCitations` with a trivial
  in-memory searcher (the MCP `validate_citations` path).
- `resolveReference(uri, {network})` — optional HEAD liveness check; **off by
  default** to honor no-network-at-query-time.
- `verifyClaim(claim, sources, threshold=0.3)` — lexical recall of claim terms
  against the best source (model-free).

### 6.2 Token-budget assembly & orchestration

- `assembleWithinBudget(hits, maxTokens, counter)` (`assemble.ts`) — greedily
  keep top-ranked hits within a token budget, deduping by normalized content;
  the single best hit is always kept. `approxTokens` = `~len/4`.
- `orchestration.ts` — Bridge-pattern layer weights: `classifyQueryIntent`
  (`scoped|shared|balanced` from lexical hints), `layerWeights`, `projectWeights`,
  `layerOf` — the substrate for shared+scoped global weighting.

---

## 7. Intent memory (`src/intents/store.ts`)

Learns from the **conversation**: which user intents recur, how often, the
assistant's response, and whether it resolved the intent. Postgres-backed
(`intent`/`intent_resolution`). Used by the CLI, MCP, and the Claude Code hooks.

- **Normalize** (`normalizeIntent`): drop code fences, lowercase, keep word/number
  tokens, strip greeting/filler. `intentId` = `"i" + sha256(normalized)[:30]`.
- **`record(text, {project, session, response})`** — UPSERT intent (increment
  `frequency`), open a pending `intent_resolution` row (the Stop hook fills/grades
  it later; a given `response` fills the excerpt up front). Caps resolutions at
  `RESOLUTION_CAP=12` (best by score + always the newest). Returns the intent id
  (`""` if it normalizes to nothing).
- **`recall(query, project, topk=3)`** — **fast, model-free**: exact normalized
  id, then lexical Jaccard token-overlap over candidates pulled by `ILIKE`. Honors
  `INTENT_MIN_SCORE` (default 0.45); current project preferred over global.
- **`recallInjection(...)`** — renders a compact, token-bounded context block
  (frequency, the best successful resolution, one cautionary failure) ≤
  `INTENT_MAX_TOKENS`.
- **`resolve(intent, outcome, score, project)`** — record an explicit outcome
  (`grader='explicit'`).
- **`gradePending(transcriptPath)`** — grade the finished exchange: prefer a
  **local Ollama judge** (unless `INTENT_NO_JUDGE`), else a transcript heuristic
  (a re-ask of a similar intent ⇒ unresolved; acceptance phrase ⇒ resolved;
  rejection ⇒ unresolved). Also finalizes the previous user turn now its follow-up
  is visible.
- **`stats()`** — frequency leaderboard (top 25).

---

## 8. Daemon (`src/daemon/`)

`runDaemon(signal)` bootstraps the schema (`ensureSpace()`) then runs three
subsystems concurrently against the shared Postgres store, until SIGINT/SIGTERM
aborts. The searchable path (ingest → embed → search) never needs Ollama; only
derived abstraction tasks do.

- **Chat feeder** (`feeders/chat.ts`) — watches `CHAT_GLOBS`
  (`~/.claude/projects/**/*.jsonl`), parses transcripts past a per-file watermark
  in `daemon_state` (`chat:<file>`), UPSERTs `session`/`message`. New rows
  auto-enqueue `embed` jobs via the DDL trigger. Cadence `CHAT_INTERVAL` (5s).
- **Source feeder** (`feeders/source.ts`) — periodic sweep calling
  `ingestProject` for every project (diff-by-hash skips unchanged). Cadence
  `SOURCE_INTERVAL` (300s). Records `source:<project>` watermarks.
- **Worker** (`worker.ts`) — drains `digest_job`: `LISTEN digest` for low
  latency + 2s poll fallback; claims with `FOR UPDATE SKIP LOCKED`. `embed` jobs
  embed the referenced chunk/message/reference (reference text =
  `title||' '||snippet`) and fill `embedding_id` (UPSERT into the space table).
  `summarize`/`extract*` route to a local Ollama generate (best-effort; optional).
  Unknown tasks are marked `done`. On error: requeue, or `dead` once
  `attempts >= max_attempts`.

**Job lifecycle:** `queued → leased → done` (or `failed`/back to `queued` on
retry, `dead` after `max_attempts`). New chunk → `embed` → (cascade) extract/
summarize/cluster.

**Service management** (`vectors daemon …` / `skills/vector-index/daemon/`):
launchd on macOS (`com.vectors.ukdb`, logs `~/Library/Logs/ukdb-daemon.*.log`),
systemd `--user` on Linux (`ukdb-daemon.service`).

> **Roadmap (not implemented).** Opt-in daemon backup providers
> (`VINDEX_BACKUP_PROVIDER`, ~daily `pg_dump -Fc`): `folder` (local dir / OneDrive
> / Google Drive sync folder), `rclone` (cloud remote), `obsidian` (vault +
> manifest note), `notion` (manifest page), retention `VINDEX_BACKUP_RETENTION`.
> See the README Roadmap section. Until then, back up manually with
> `pg_dump`/`pg_restore`.

---

## 9. MCP tools (`src/mcp/`)

`createMcpServer()` (`src/mcp/server.ts`) builds the server — name `vectors`,
version `0.3.0`, `@modelcontextprotocol/sdk` — with 13 tools, served over two
transports: **stdio** (`vectors mcp`; bootstrap gated behind `import.meta.main`)
and **streamable HTTP** (`vectors mcp http`, § 9.1). Each tool returns a text
content block (JSON). Where `project` is omitted it auto-resolves from cwd.

| Tool | Required | Optional | Behavior |
| --- | --- | --- | --- |
| `search` | `query` | `project, topk, rerank` | One project, hybrid+reranked. |
| `search_global` | `query` | `topk, rerank, projects` (comma list) | Across all/subset, merged+reranked. |
| `current_project` | — | — | `{ project }` resolved from cwd. |
| `list_projects` | — | — | Projects + document/chunk/embedded counts. |
| `project_status` | — | `project` | Project row + config. |
| `ingest` | — | `project` | Incremental ingest. |
| `reindex` | — | `project` | Wipe + rebuild. |
| `create_project` | `name` | `root, embed_model, rerank_model` | Create project. |
| `add_source` | `path` | `project, id, type, globs` (comma), `base_url` | Add a source. |
| `validate_citations` | `text` | `project, topk` | Ground claims against the corpus (`checkGroundedness`). |
| `resolve_reference` | `uri` | `network` | Resolve a URI/citation (optional HEAD). |
| `recall_intents` | `query` | `project, topk` | Model-free intent recall. |
| `resolve_intent` | `intent, outcome` | `score, project` | Record a resolution. |

Example call/result:

```jsonc
// → tools/call  search
{ "name": "search", "arguments": { "query": "deterministic seeded geometry", "topk": 3 } }
// ← content[0].text (JSON)
{ "query": "deterministic seeded geometry", "project": "scene",
  "confidence": "high", "agreement": true,
  "hits": [ { "chunk_id": "…", "project": "scene", "title": "src/geo.ts › seedMesh",
              "unit_type": "symbol", "dense": 0.71, "sparse": 0.4, "rrf": 0.03,
              "rerank": 6.2, "score": 6.2, "text": "…", "url": null } ] }
```

```jsonc
{ "name": "add_source",
  "arguments": { "path": "/abs/scene", "id": "code", "type": "dir",
                 "globs": "**/*.ts,**/*.md", "base_url": "https://x/{path}" } }
// ← { "ok": true, "project": "scene", "source": { … } }
```

Bundled registration: `.mcp.json` → `bun ${CLAUDE_PLUGIN_ROOT}/src/mcp/server.ts`.

### 9.1 Streamable-HTTP transport (`src/mcp/http.ts`)

The network-reachable counterpart of stdio, deployable behind a reverse proxy
(e.g. nginx `/mcp`). **Stateless**: a fresh `Server` +
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per request —
the simplest robust shape behind a load-balancing/buffering proxy. Built on
`node:http` (runs under Bun), binds `127.0.0.1:$VINDEX_MCP_HTTP_PORT` (alias
`PORT`, default `8765`). Routes: `POST/GET/DELETE /mcp` (MCP),
`GET /health` → `ok`. Boot runs `ensureSpace()` to bootstrap the schema on a
fresh DB; SIGINT/SIGTERM drain the pg pool. The HTTP server has no client cwd —
pin `VINDEX_PROJECT` per deployment or use `search_global`.

---

## 10. Hooks (`hooks/`)

Claude Code hooks wired via the plugin manifest (`hooks/hooks.json`):

- **`UserPromptSubmit` → `user_prompt_submit.ts`** — reads `{prompt, cwd,
  session_id}` on stdin, does a fast model-free `recall` (wall-clock budget
  `VINDEX_INTENT_TIMEOUT`, default 1.5s), and prints a
  `<vindex-intent-memory>…</vindex-intent-memory>` block to stdout (the harness
  adds it to context). Then fires a **detached** `vectors intent record` so
  storage never blocks. No-op under `VINDEX_INTENT_DISABLE`; always exits 0.
- **`Stop` → `stop.ts`** — reads `{transcript_path, cwd}`, fires a **detached**
  `vectors intent grade <transcript>` so the (possibly slow) Ollama judge never
  holds up the turn. No-op under `VINDEX_INTENT_DISABLE`; always exits 0.

Both paths skip harness-injected "user" text (`isMachineText` in
`src/transcript.ts`): task-notifications, system reminders, slash-command
envelopes, and command output are neither recorded, recalled against, nor
graded — only genuine human prompts enter the intent store.

---

## 11. CLI surface (`src/cli/`)

`vectors` → `src/cli/index.ts`. A command registry matches the **longest**
registered path prefix in argv. Bare `vectors` (no args) launches the interactive
TUI; `vectors help [--all]` lists commands (`--all` includes hidden agent
commands). There is **no `vindex` bin** and no legacy multi-step commands.

**primary**
- `vectors index <name> [path] [--glob G …] [--embed M] [--rerank M] [--url T] [--rebuild]`
  — the whole index flow in one command: create the project (idempotent), attach a
  source (path defaults to the cwd; a Git `origin` remote becomes the `{path}` URL
  template; `--url` overrides), and ingest it incrementally (`--rebuild` wipes
  first). Guards: `assertWritable` then per-source `assertAllowedRoot`.
- `vectors search <text…> [--project P] [--global] [--projects A,B] [--topk N] [--no-rerank] [--json]`
  — searches the current project by default; `--global`, `--projects`, or an
  `all:` query prefix searches across projects, merged + reranked.
- `vectors ls [name] [--json]` — list projects with doc/chunk counts (`*` =
  active); with a name, print that project's config + stats.
- `vectors viewer [name] [outPath] [--serve]` — write the static all-projects
  offline viewer (default), or run the live HTTP viewer with `--serve`.
- `vectors daemon <start|stop|status|logs>` — `start` installs + launches the
  service (launchd/systemd); `stop` removes it. (Hidden: `daemon run`, the service
  entry point.)
- `vectors mcp` — run the stdio MCP server.
- `vectors setup [--link] [--daemon] [--no-deps] [--yes]` — (re)apply schema +
  migrations + default space; full provisioning + editor/MCP wiring lives in
  `setup.sh`.
- `vectors doctor` — diagnose Bun, DSN, Postgres, pgvector, schema, daemon.

**hidden (agent / hooks; shown under `vectors help --all`)**
- `vectors intent <record|recall|resolve|grade|stats>` — intent memory.
- `vectors prompt [name]` — print a reasoning-scaffold template.

### 11.1 Interactive TUI (bare `vectors`)

Built on `@opentui/core` (`src/cli/tui.ts`), driving the same `match`/`dispatch`
registry as the flag CLI. Features: command autocomplete over the registry (Tab
accepts), a project switcher (Ctrl-P), and a query-first prompt — a bare line runs
a search in the active project. Meta-commands: `:project NAME`, `:help`, `:q`;
Ctrl-C exits.

---

## 12. Config / environment (`src/config.ts`)

`VINDEX_*` is canonical; legacy `UKDB_*` (and a few others) are accepted as
**deprecated aliases** via `envAny()` (first non-empty wins).

| Variable (canonical) | Aliases | Default | Meaning |
| --- | --- | --- | --- |
| `VINDEX_DSN` | `UKDB_DSN` | `postgres://localhost:5432/vectors` | Postgres DSN. |
| `VINDEX_HOME` | — | `$XDG_DATA_HOME/vector-index` or `~/.local/share/vector-index` | Config + cache home (vectors live in Postgres). |
| `VINDEX_EMBED_MODEL` | — | `all-MiniLM-L6-v2` | Default embed model. |
| `VINDEX_RERANK_MODEL` | — | `cross-encoder/ms-marco-MiniLM-L6-v2` | Default reranker. |
| `VINDEX_PROJECT` | — | (unset) | Pin the active project (wins over cwd resolution). |
| `VINDEX_DEFAULT` | — | `default` | Fallback project name. |
| `VINDEX_READONLY` | — | off | Block all mutating ops. |
| `VINDEX_ALLOW_ROOTS` | — | (none) | `:`-separated allow-roots for ingest/create. |
| `VINDEX_INTENT_DISABLE` | — | off | Hooks become no-ops. |
| `VINDEX_INTENT_SYNC_EMBED` | — | off | Semantic recall inline. |
| `VINDEX_INTENT_NO_JUDGE` | — | off | Skip Ollama judge, heuristic only. |
| `VINDEX_INTENT_MIN_SCORE` | — | `0.45` | Recall inject threshold. |
| `VINDEX_INTENT_MAX_TOKENS` | — | `400` | Injection token budget. |
| `VINDEX_INTENT_TIMEOUT` | — | `1.5` (s) | Recall wall-clock budget (hook). |
| `VINDEX_OLLAMA_URL` | `UKDB_OLLAMA_URL`, `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama (judge/digest). |
| `VINDEX_OLLAMA_MODEL` | `UKDB_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model. |
| `VINDEX_CHAT_GLOBS` | `UKDB_CHAT_GLOBS` | `~/.claude/projects/**/*.jsonl` | Transcript globs (comma list). |
| `VINDEX_CHAT_INTERVAL` | `UKDB_CHAT_INTERVAL` | `5` (s) | Chat feeder cadence. |
| `VINDEX_SOURCE_INTERVAL` | `UKDB_SOURCE_INTERVAL` | `300` (s) | Source feeder cadence. |
| `VINDEX_VIEWER_PORT` | `PORT` | `7341` | 3D viewer port. |
| `VINDEX_MCP_HTTP_PORT` | `PORT` | `8765` | Streamable-HTTP MCP port (`vectors mcp http`). |

`DEFAULT_EMBED_DIM = 384`. Project resolution order (`resolveProjectName`):
`$VINDEX_PROJECT` → nearest ancestor matching a `project.root_path` → nearest
ancestor with a `.vindex`/`.git` marker (basename) → `$VINDEX_DEFAULT`.

---

## 13. Viewer (`src/viewer/`)

3D "synapse" navigator. `runViewer(project, port)` serves `assets/viewer.html`
on `127.0.0.1` plus a JSON API (`node:http`, runs under Bun). PCA via `ml-pca`.

- `GET /` — the viewer page.
- `GET /api/status` — `{ name, doc_count (chunks, kept for old baked payloads),
  documents, chunks, embedded, embed_model, state }` (`state` = `ready` or
  `embedding X/Y`).
- `GET /api/inventory?limit=&offset=` — full data inventory:
  `{ project: { name, embed_model, documents, chunks, embedded, state, sources,
  docs, docs_total, offset, limit }, global }`. `sources` is the project's
  `SourceConfig[]`, `docs` a paginated document listing (`limit` 1–500, default
  200) with per-document chunk counts, `global` the `listProjects()` summaries.
- `GET /api/doc?id=…` — one document's chunk listing (inventory drill-down
  leaf): `{ id, rel_path, title, chunks: [{ id, ordinal, title, unit_type,
  token_count, embedded }] }`.
- `GET /api/node?id=…` — full chunk detail for the side panel: `{ id, title,
  source (rel_path), source_id, chunk (ordinal), unit_type, url, text, symbol,
  char_count, references, relations, document }`. `references` come from
  `link`→`reference` rows, `document` lists ordinal-ordered siblings (with
  `self` + `graph_index` when sampled), `relations` are the top-6 cosine
  neighbours within the currently sampled graph (empty until `/api/graph` ran).
- `GET /api/graph?n=400&k=3` — sample up to `n` embedded chunks (`n` 50–1200),
  PCA(3) project their real embeddings into a `~[-6,6]` box, and build `k` (1–6)
  nearest-neighbour synapse links by cosine. Returns `{ nodes, links, k }`; nodes
  carry `{ id, title, source, url, chunk, unit_type, snippet, p:[x,y,z] }`. The
  fitted PCA is retained so search hits land in the same space.
- `GET /api/search?q=…` — reranked `searchProject` (topk 8); hits already in the
  sampled graph carry a `graph_index`, otherwise PCA coords `p` + nearest
  `attach` links. Each entry carries `score`, optional `rerank_score`, and
  `signals` (`dense`/`sparse`).

Interaction semantics in the viewer page:

- **Selection lock** — while a node is focused, pointer clicks cannot re-target
  the selection; a click on empty space or `Esc` deselects. Arrow-key traversal
  and detail/inventory row clicks still move the focus deliberately.
- **Focused edges** — the focused node's incident edges are drawn on a bright
  overlay `LineSegments` (preallocated to the max node degree) while the base
  edge mesh dims to opacity `0.14`; both restore on deselect.
- **Weighted search hits** — result nodes scale `1.3–2.6` by their final hybrid
  `score` normalized against the best hit (static exports fall back to
  token-match counts); non-hits dim as before.
- **Data inventory** — the `▸ data` brand link or `d` toggles a right-side panel
  listing the project's sources and documents (expandable to per-chunk rows via
  `/api/doc`; chunk rows focus the graph node or load its detail) plus all
  projects globally; clicking a project switches the viewer to it. Static
  exports show the global list only.

`vectors viewer export [out]` (`make_demo.ts`) writes a standalone
`docs/viewer-demo.html` by injecting `window.VINDEX_DEMO=true` into the canonical
viewer — a procedural embedding cloud, no backend.

---

## 14. Generalized capabilities

The retrieval machine maps onto domain-agnostic capabilities (see
`skills/vector-index/references/generalized-capabilities.md`): C1 typed semantic
units, C2 structure-aware context-prefixed chunking, C3 hybrid dense+sparse RRF
+ cross-encoder rerank, C4 layered (Silo/Pool/Bridge) orchestration, C5
provenance/grounding, C7 token-budget assembly, C9 capability guards, C11
reasoning/grounding prompt scaffolds. The implementation realizes C1–C3, C5, C7,
C9, C11 today; the unified-db schema (§2) is the substrate for the rest.
