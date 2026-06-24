# Unified Knowledge Database — spec

A single, local PostgreSQL database that unifies — and lets you cross-reference —
everything the agent knows:

1. **Vector data** — chunk embeddings in
   [pgvector](https://github.com/pgvector/pgvector), partitioned by project.
2. **Chat memory / history** — sessions and messages.
3. **External references** — URLs, Google Drive files, Notion pages, GitHub
   links, citations mentioned in any context.
4. **Own content** — the full text of your documents and project codebases, plus
   their chunks.

On top of that it adds a four-level **memory abstraction** ladder, a background
**digest** pipeline driven by a local **Ollama** worker, a constantly-learning
**fact** store, and the metadata a **token-budgeted retrieval** assembler needs.

The companion file [`unified-knowledge-db.sql`](unified-knowledge-db.sql) is the
authoritative, copy-pasteable DDL. This document explains *why* each piece is
shaped the way it is. **It is implemented** — the live engine (`src/`, TypeScript
on Bun) runs on exactly this schema; the repo-root
[`spec.md`](../../../spec.md) is the authoritative spec of the shipped system,
and [`architecture.md`](architecture.md) maps the modules.

## The engine

The store is **one PostgreSQL + pgvector database** holding many projects (chunk
embeddings live in per-space `emb_<model>_<dim>` tables, not per-project files).
Embeddings come from `@xenova/transformers` (ONNX, default `all-MiniLM-L6-v2`,
384-dim) and hits are reranked by a cross-encoder — both **pure JS/WASM, no
Python**. Ollama is used **solely** for autonomous, "haiku-level"-trusted digest
tasks (summaries, concept extraction, clustering, fact/reference extraction,
dedupe), never on the query hot path.

## Conventions

Target **PostgreSQL 16** + **pgvector ≥ 0.7**, with `pgcrypto` (UUIDs) and
`pg_trgm` (trigram index on reference URIs / lexical dedupe assist). UUID primary
keys throughout; `timestamptz` for time; `jsonb` for open-ended metadata;
`content_hash` (sha256 `bytea`) for dedup and change detection.

---

## 0. The decision that shapes everything: per-project embedding dimension

pgvector columns are **fixed-dimension** (`vector(384)`), and an HNSW index can
only be built on a fixed-dim column. But `embed_model` — and therefore the
dimension — varies per project today (MiniLM = 384, but a project could choose
`bge-large` = 1024, etc.).

Three tempting options are rejected:

- **One nullable column per possible dim** — unbounded, can't be indexed
  generically.
- **Pad / truncate to a max dim** — corrupts cosine geometry; non-starter.
- **Single physical column + partitioning by dim** — a column still has exactly
  one type, so this doesn't actually hold mixed dims.

**Chosen approach — an `embedding_space` registry plus one physical
`emb_<space>` table per distinct `(model, dim, metric)`, created on demand.**
Each space's table has a real `vector(dim)` column and its own HNSW index;
everything that owns a vector references it indirectly by
`(space_id, embedding_id)`, so the rest of the schema is dimension-agnostic. This
is the only approach that keeps every HNSW index dimension-correct, lets projects
keep heterogeneous models, and matches a fact that is already true today:
**cross-model vector scores are not comparable** — comparison happens at the
cross-encoder rerank layer, never across raw vectors. Most installs will have
exactly one space (MiniLM / 384), so the common path is a single table.

Embeddings are L2-normalized at ingest (as today), so cosine equals inner
product; the default space uses `vector_cosine_ops`. `content_hash` is unique per
space, which is also the **dedup** mechanism: a chunk and a verbatim chat message
with identical text share one vector row.

---

## 1. Multi-project structure (feature 1)

`project` carries the per-project config (`name`, `root_path`, `embed_model`,
`rerank_model`, chunk config, and `sources` jsonb) plus a `space_id` and a
self-referential **`parent_id`** for a parent/child hierarchy (walk it with a
recursive CTE).

**Siblings are not columns.** Sibling / "related" relationships are many-to-many
and can cross projects, so they live in the polymorphic `link` table (§6) with
`relation = 'sibling' | 'related'`. This is what satisfies "knows which
project/parent a content belongs to, *or is a sibling of*" without hard-coding a
single parent.

**Tagged, not isolated.** `chunk.project_id` and `message.project_id` are
denormalized so a filtered ANN query stays single-table, but nothing forbids
cross-project links or NULL-project (global) nodes. Project search adds a
`WHERE project_id = …` filter; global search drops it (or uses
`project_id = ANY(…)`). This preserves today's "isolated collection, searchable
together" behaviour.

**Resolution is unchanged.** The existing `resolve_project_name` precedence —
`$VINDEX_PROJECT` → nearest-ancestor `root_path` → `.git`/`.vindex` marker walk →
default — ports verbatim; it just queries the `project` table instead of scanning
`$VINDEX_HOME`.

---

## 2. Own content: documents + chunks (feature 4)

`document` holds one row per source file, **including its full `content`** (so the
DB is the system of record for your own material, not just an index over it).
`chunk` holds one row per embedded slice, with the stored `text` (as today, so
search never reconstructs from disk).

The old stable id `"v"+sha256(source_id\0source\0chunk)[:30]` is replaced by
`content_hash` plus `UNIQUE(document_id, ordinal)`: re-ingesting the same file
**UPSERTs** rather than duplicating. A whole-file `document.content_hash` lets
ingest skip unchanged files entirely.

---

## 3. Chat memory: sessions + messages (feature 2, new)

`session` groups a conversation (optionally tied to a project); `message` stores
each turn (`role`, `seq`, `text`, `token_count`) with a nullable
`(space_id, embedding_id)` filled in by the digest worker. A raw message is an
**L0** node (§4) exactly like a chunk — verbatim, exact, and addressable from both
the memory ladder and the cross-reference table. This is what makes "what did we
decide in <project>?" answerable from past chat alongside docs.

---

## 4. The memory abstraction ladder L0–L3 (feature 2)

A single `memory_node` table whose rows form a **DAG** via `derivation` edges.
`level` places a node on the exactness ladder:

| Level | Exactness | What it is | Built from |
| --- | --- | --- | --- |
| **L0** | exact | one node per `chunk` or `message`, anchored, verbatim | the content itself |
| **L1** | summary | per-document or per-exchange digest | the L0 nodes of that doc / exchange |
| **L2** | topic | a cluster / theme grouping | many L1 nodes |
| **L3** | concept | the vaguest conceptual separation (top) | L2 nodes |

L0 nodes set `anchor_kind`/`anchor_id` and carry no summary; a `CHECK` enforces
`level='L0' ⇔ anchored`. L1+ nodes are **derived** by Ollama and carry generated
`summary`/`label` prose. Every node is embeddable and searchable.

### Updatability — the headline guarantee

The ladder is **decoupled** from raw content so it can be rebuilt without ever
touching the originals:

1. Each `derivation` edge stores the child's `content_hash` **at build time**
   (`child_hash`). A node's `source_fingerprint` is the hash of the sorted set of
   its children's hashes — one comparison tells you "did any child move?"
2. When raw content changes, its L0 node's `content_hash` changes (re-embed → new
   `embedding_id`). Any derived node whose `source_fingerprint` no longer matches
   is flagged `is_stale`, and staleness propagates **up** the DAG.
3. A background `rebuild_abstraction` job regenerates stale nodes **bottom-up**:
   Ollama rewrites `summary`/`label`, `version` bumps, `source_fingerprint`
   recomputes, the node re-embeds, `is_stale` clears.

Raw L0 content (chunks, messages, facts) is **never** mutated by a rebuild —
regeneration only writes `memory_node` / `derivation` rows. That is the "can be
updated if needed" requirement, made structural rather than aspirational.

---

## 5. External references (feature 3)

`reference` is **global**, not project-scoped: the same Notion page or URL can be
cited from many projects, so it gets one canonical row keyed by `(kind, uri)` with
a cached `title`/`snippet`, open `metadata` jsonb, and an optional embedding of
its title+snippet. A trigram index on `uri` supports fuzzy lookup and dedupe.
References connect to whoever mentions them through the `link` table
(`mentions` / `cites`). The `extract_references` digest task is what discovers
them in chunk and message text.

---

## 6. Cross-reference model: one polymorphic `link` table

**Decision: a single polymorphic `link` table**, chosen over typed join tables.

The requirement is explicitly N-way and open-ended — chunks, messages,
references, memory nodes and facts must all link to each other, across projects,
under several relationship semantics (`sibling`, `related`, `cites`, `mentions`,
`derived_from`, `duplicate_of`, `parent_child`). Typed join tables would
multiply combinatorially (`chunk_reference`, `message_reference`, `memory_chunk`,
`chunk_chunk_sibling`, …) and every new node type would force new tables and new
query branches. One polymorphic table keeps the relation set closed and lets
retrieval traverse uniformly.

The cost — no single-column FK enforcement on `(kind, id)` — is mitigated by the
`node_kind` enum, a validation trigger, a periodic orphan-GC pass, and the fact
that pairs are always written by the app/worker, never by end users.

`link` carries `relation='derived_from'` too, but the abstraction DAG keeps its
**own** `derivation` table because it additionally needs `child_hash` for
staleness; `link` is for everything else and for surfacing cross-references during
retrieval.

---

## 7. Constantly-learning memory: the `fact` store (requirement 4)

Distinct from the abstraction ladder, `fact` stores extracted intel worth keeping
for the future — `fact_type ∈ {fact, preference, decision, entity}` — each with
`confidence` (from the extractor), `salience`, `hit_count`, `last_used_at`, and a
`status ∈ {active, superseded, retracted}`.

- **Reinforcement:** every time a fact is surfaced *and used*, `hit_count++`,
  `last_used_at = now()`, and `salience` is bumped.
- **Decay is computed, not a destructive rewrite:**
  `effective_salience = salience · e^(−λ·age) + β · ln(1 + hit_count)`,
  materialized lazily at read time or by a periodic background pass.
- **Never hard-delete:** near-duplicates are collapsed with `duplicate_of` links
  and `status='superseded'`, so a wrong merge is reversible.

This is the substrate for "automatic background storing of any possibly useful
intel": the `extract_facts` digest task writes here, and decay quietly retires
low-confidence, unreinforced entries.

---

## 8. Background digesting via Ollama (feature 3)

`digest_job` is a queue with a state machine
(`queued → leased → done | failed | dead`), a `dedupe_key` to collapse redundant
enqueues, attempt/backoff bookkeeping, and a lease for crash recovery. `payload`
carries **ids, never blobs**.

### Task catalog (all on local Ollama, haiku-trusted)

| Task | Input (payload) | Output | Side effects |
| --- | --- | --- | --- |
| `embed` | `{node_kind, id}` | vector | upsert into the space table, set `embedding_id` |
| `summarize` | `{level, child_ids[]}` | summary text | upsert L1/L2 `memory_node` + `derivation` edges |
| `extract_concepts` | `{node_id}` | concepts/labels | create/attach L2/L3 nodes |
| `cluster_topics` | `{project_id, level}` | clusters | create L2 nodes + `derivation` edges |
| `extract_references` | `{node_kind, id}` | refs[] | upsert `reference` + `link(mentions/cites)` |
| `extract_facts` | `{node_kind, id}` | facts[] | upsert `fact` with confidence |
| `dedupe` | `{kind, candidate_ids[]}` | merge map | `link(duplicate_of)`, mark `superseded` |
| `rebuild_abstraction` | `{node_id}` | new summary | bump `version`, clear `is_stale`, re-embed |

### Worker contract

Workers claim work atomically so many can run safely:

```sql
UPDATE digest_job SET state='leased', attempts=attempts+1,
       lease_until = now() + interval '5 min', updated_at = now()
WHERE id = (
  SELECT id FROM digest_job
  WHERE state='queued' AND priority <= $1
  ORDER BY priority, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1)
RETURNING *;
```

On success → `state='done', result=…`. On failure → re-`queued` with backoff
until `attempts >= max_attempts` → `'dead'`. A reaper requeues rows whose
`lease_until < now()` (crashed workers).

### Enqueue: LISTEN/NOTIFY for latency, polling for correctness

A trigger on inserts to `chunk` / `message` / `reference` enqueues the first job
(`embed`) and fires `pg_notify('digest', …)`. Workers `LISTEN digest` for
low-latency wakeups **and** poll `job_ready_idx` every few seconds — because
NOTIFY is fire-and-forget (a worker mid-task or just-connected misses it) and
doesn't survive dropped connections. **NOTIFY is the optimizer; the poll is the
source of truth.** Everything after `embed` is **data-driven cascade**: `embed`
done → enqueue `extract_*` → `summarize` → parent `cluster_topics`, each with a
`dedupe_key` so a busy project doesn't pile up redundant work.

### The background daemon (macOS-first)

The worker and the two feeders that keep the store current are implemented as a
single long-lived process, [`src/daemon/daemon.ts`](../../../src/daemon/daemon.ts)
(TypeScript on Bun), with launchd/systemd install tooling in
[`daemon/`](../daemon/README.md):

- **Chat feeder** — watches chat-transcript files (Claude Code / Desktop JSONL by
  default) and upserts new `session` / `message` rows; each insert fires the
  enqueue trigger, so new chat context becomes searchable automatically.
- **Source feeder** — re-ingests each project's configured `sources` (the jsonb
  array on the `project` row) into `document` / `chunk`, content-hash diffed,
  reusing the engine's chunking (`src/db/ingest.ts`).
- **Job worker** — the queue consumer above: `embed` via `@xenova/transformers`
  (ONNX, no network) plus the Ollama digest tasks.

On macOS `daemon/install.sh` writes a launchd LaunchAgent
(`com.vectors.ukdb`, `RunAtLoad` + `KeepAlive`) with env baked in from
`ukdb-daemon.env`; on Linux it writes a `systemd --user` unit. Because chunks can
now be inserted by a feeder and embedded later by the queue, `chunk.embedding_id`
is **nullable** (the worker fills `(space_id, embedding_id)` and creates the L0
`memory_node`); migration that already has vectors fills them inline instead.
Feeder watermarks (transcript offsets, source-scan times) live in a small
`daemon_state` key/value table so restarts resume cleanly.

### Optional remote backup

When `UKDB_BACKUP_PROVIDER` is set, the daemon also `pg_dump`s the whole DB
(`-Fc`) and pushes it to one or more **pluggable providers**, self-throttled to
~once a day (default 24h) and tracked in `daemon_state` so restarts don't
double-back-up. Providers:

- **`folder`** — copy into any local directory; pointed at a OneDrive or Google
  Drive *local sync folder* this reaches those clouds with no API setup.
- **`rclone`** — true cloud upload via a configured `rclone` remote (OneDrive,
  Google Drive, etc.) when no local sync exists.
- **`obsidian`** — copy into a vault subfolder and maintain a `UKDB Backups.md`
  index note (mirror via Obsidian Sync / iCloud).
- **`notion`** — write a backup *manifest* page (timestamp, size, sha256,
  location); the dump bytes go to a byte-storing provider above, so Notion serves
  as a searchable catalog rather than holding multi-MB binaries its API can't.

Retention keeps the newest N dumps. This keeps a local-first store recoverable
off-machine without coupling the daemon to any single vendor SDK — the byte path
is a `pg_dump` file and the providers are thin adapters.

---

## 9. Token-saving retrieval (feature 5)

The point of the ladder is to **spend the fewest tokens that still answer**. The
assembler walks it **top-down**:

1. **Embed the query** (`@xenova/transformers`, ONNX) into the project's space.
2. **Coarse pass:** ANN over `memory_node` filtered to `level IN ('L3','L2')`
   (plus the project filter, or none for global). These nodes are few and small.
3. **Progressive drill:** for the best coarse nodes, follow `derivation` edges
   down to L1 summaries, and only for the single best L1s down to L0 (`chunk` /
   `message` via `anchor_*`) for verbatim text.
4. **Cross-encoder rerank** the mixed-level candidate set — exactly as today, and
   also what keeps mixed-model / global candidates comparable.
5. **Budget assembler:** keep a running token sum from per-row `token_count`;
   greedily include nodes by rerank score, **preferring the highest level that
   still answers** (an L2 summary is cheap; swap in its L0 children only when the
   query demands exactness). Attach `link`ed references as compact citations
   (title + uri, not full body) until the budget is hit. Dedup by `content_hash`
   so a chunk and an identical message aren't both spent.
6. **Reinforce:** nodes/facts actually emitted bump `hit_count` / `salience` /
   `last_used_at`.

Precomputed L1–L3 summaries (and their embeddings) are what make step 2 cheap —
without them every query reads raw chunks. **That is the core token saving** for
upcoming chats: send a 200-token concept digest instead of 4,000 tokens of raw
context, and drill only on demand.

---

## 10. Migration from zvec, and the four touchpoints (historical)

> **Historical.** The migration described below is complete: the engine now runs
> natively on Postgres + pgvector (TypeScript on Bun, `@xenova/transformers`).
> This section is retained as a record of how the store was swapped from the
> former Python/zvec engine.

### Data migration (per project, idempotent)

1. For each `$VINDEX_HOME/<project>/config.json`: upsert a `project` row; ensure
   an `embedding_space` row for its `(embed_model, embed_dim)` and create the
   `emb_<space>` table if missing.
2. Iterate the zvec collection (or re-walk sources). For each record, upsert
   `document` (by `project_id, source_id, rel_path`) and `chunk` (by
   `document_id, ordinal`). Fields map 1:1 — `source_id → document.source_id`,
   `source → rel_path`, `title`, `chunk → ordinal`, `url`, `text`,
   `embedding → emb_<space>.embedding`. **Reuse the stored zvec embeddings
   directly** (same model, same dim — no re-embed).
3. Create one L0 `memory_node` per chunk. Leave L1+ to the digest workers (enqueue
   `summarize` / `cluster_topics`).
4. `parent_id` / sibling `link`s are opt-in post-migration; default is flat,
   mirroring today.

### The four `Index` touchpoints map cleanly

This is the swap the architecture doc was designed for:

- **`_schema`** → the DDL in `unified-knowledge-db.sql` (run once / via
  migrations). "Create collection" becomes "ensure `project` + `embedding_space`
  rows and the per-space `emb_<space>` table."
- **`open`** → acquire a `psycopg` connection / pool to the shared DB (replacing
  `zvec.open(path)`); there is no per-project file. Project context is a
  `project_id`, resolved by the unchanged `resolve_project_name`.
- **`ingest`** → the same chunk/embed pipeline, but the insert phase becomes
  batched `INSERT … ON CONFLICT DO UPDATE` into `document` / `chunk` /
  `emb_<space>` (+ the L0 `memory_node`), then enqueue digest jobs. Transaction
  commit replaces `flush()` / `optimize()`; HNSW maintenance is automatic.
- **`search`** → embed the query (unchanged), then
  `ORDER BY embedding <=> $q LIMIT fetch_k` on the project's `emb_<space>` joined
  to `chunk` (filtered by `project_id`), then the unchanged cross-encoder rerank.
  `global_search` is the same query without the `project_id` filter (or
  `project_id = ANY(…)`), still merged + cross-encoder reranked across the union.
  Tune `SET hnsw.ef_search` per query for the recall / `fetch_k` trade-off.

The app-layer embedding model and cross-encoder reranker are untouched; only the
store changes.

---

## 11. Trade-offs & risks

1. **Per-space tables add operational surface.** Creating tables at runtime when a
   new model appears is DDL on the hot path and complicates backups. *Mitigation:*
   strongly default everyone to one space (MiniLM / 384); treat extra spaces as
   rare. Acceptable because cross-model vectors were never comparable anyway —
   rerank already arbitrates.
2. **Polymorphic `link` / `memory_node.anchor` sacrifice FK integrity.** Orphaned
   links are possible after deletes. *Mitigation:* validation triggers + a
   periodic GC + app-only writes. The alternative (a dozen typed join tables) is
   worse for traversal and extensibility.
3. **Abstraction staleness can stampede.** A big re-ingest invalidates many L0 →
   cascades `is_stale` up the DAG → a flood of `rebuild_abstraction` jobs hammering
   Ollama. *Mitigation:* debounce via `dedupe_key`, rebuild bottom-up in priority
   order, rate-limit the Ollama pool. Abstractions lag raw content during heavy
   churn — acceptable eventual consistency for a RAG memory.
4. **HNSW recall under filtering.** `WHERE project_id = …` pre-filtering an HNSW
   scan can hurt recall when a project is a small slice of a huge table.
   *Mitigation:* raise `ef_search`, or partition `chunk` / `emb_<space>` by
   `project_id` for project-heavy installs. A non-issue for the common
   single-project query.
5. **Trusting a local model for autonomous facts/dedupe.** "Haiku-level" extraction
   will produce some wrong facts and bad merges. *Mitigation:* `confidence` /
   `salience` scoring, `status='superseded'` instead of hard deletes,
   `duplicate_of` links rather than destructive merges, and decay so unreinforced
   low-confidence intel fades. A digest job must **never** mutate raw L0 content —
   only derived rows.

---

## 12. Validating this schema

```bash
# Provision local Postgres 16 + pgvector (bash setup.sh), then apply the DDL.
psql "$VINDEX_DSN" \
     -f skills/vector-index/references/unified-knowledge-db.sql
```

All extensions, enums, tables, the HNSW index, and the enqueue trigger should
create without error.
