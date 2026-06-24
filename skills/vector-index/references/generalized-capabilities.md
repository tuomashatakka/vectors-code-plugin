# Generalized RAG capabilities — abstracting the source material

Two reference documents describe retrieval-augmented systems built for very
different purposes:

- **A — codebase RAG over MCP** (TypeScript / Next.js / Supabase): a pgvector
  schema with *typed* units (files, chunks, functions, types, dependencies),
  fan-out similarity search across those indexes, token-budget trimming, MCP tool
  definitions, and environment guards.
- **B — a legal-domain RAG product** (GLC architecture): structure-aware
  chunking with hierarchy-prefix injection, hybrid dense + BM25 retrieval with
  Reciprocal Rank Fusion and cross-encoder re-ranking, multi-tenant isolation
  patterns, and a trust layer (source attribution, citation verification,
  confidence tiers, human-in-the-loop).

Stripped of their domains (TypeScript symbols; Finnish statutes), both are the
**same machine**. This note abstracts that machine into context-agnostic
capabilities and maps each onto `vectors-plugin` — what we already have, what the
unified-knowledge-db spec already covers, and what is genuinely new. Nothing here
is specific to code or law; every capability is phrased for *any* corpus.

---

## The capabilities

### C1 · Typed semantic units (not just flat chunks)
**Seen as:** A indexes `functions`, `types`, `dependencies`, `exports` as
first-class rows alongside raw chunks; B treats a statute `§` section as the unit
and carries clause-level metadata.
**Generalized:** a source item decomposes into **typed units** — `section`,
`definition`, `symbol`, `reference`, `summary` — each independently embeddable,
searchable, and filterable by `unit_type` + structured metadata. Flat chunking is
the degenerate single-type case.
**Plugin:** **shipped.** `src/chunk/units.ts` (`classifyUnit`) tags every chunk
with a `unit_type` (`section`/`symbol`/`definition`/`code`/`text`) at ingest, and
search can filter by type. AST ingestion (`src/chunk/ast.ts`) emits `symbol` /
`definition` units per declaration plus `reference`/`mentions` import edges.

### C2 · Structure-aware, context-enriched chunking
**Seen as:** B chunks at `§` boundaries and **prepends the section number, title,
and a document-level summary** to each chunk to fight "Document-Level Retrieval
Mismatch" (boilerplate-heavy docs retrieving the wrong section); A chunks code by
AST structure.
**Generalized:** chunk on the corpus's natural structural boundaries, and
**prepend each chunk's hierarchical context** (document title + heading/symbol
path, optionally a short doc summary) to the *embedded* text while storing the raw
text for display. Cheap, model-agnostic, and a large precision win.
**Plugin:** **shipped.** `src/chunk/chunker.ts` splits markdown by heading and
code by AST/line window, and ingest embeds a **context prefix** (title + path +
chunk) while storing the raw chunk for display.

### C3 · Hybrid retrieval: dense + sparse, fused, then re-ranked
**Seen as:** A fans out across several vector indexes and merges by similarity;
B runs **dense semantic + BM25 keyword in parallel (~0.7 / 0.3), fuses with
Reciprocal Rank Fusion, then cross-encoder re-ranks**, noting dense alone misses
exact tokens ("228/1929, 36 §") and sparse alone misses paraphrase.
**Generalized:** retrieve from a **dense** index (meaning) *and* a **sparse/
lexical** index (exact tokens, identifiers, citations) in parallel, **fuse with
RRF**, optionally weight by query shape, then **cross-encoder re-rank** the union.
Exact-match recall and semantic recall stop being a trade-off.
**Plugin:** **shipped.** `src/search/search.ts` runs **dense** (pgvector) +
**sparse** (Postgres full-text `tsvector`/`ts_rank`) in parallel, fuses with
**RRF**, then cross-encoder re-ranks the union; each hit carries `dense`/`lexical`
signals. (The lexical leg is Postgres FTS, not a BM25 sidecar.)

### C4 · Layered retrieval orchestration & tenancy
**Seen as:** B's isolation patterns — **Silo** (a collection per tenant), **Pool**
(one index + tenant filter), **Bridge** (dedicated for big tenants, pooled for
small, plus a **shared knowledge layer all tenants read**) — with an orchestrator
that queries shared + scoped layers in parallel, fuses with RRF, **tags each hit's
source**, and **shifts weights by query type** ("what do *we* say" → boost scoped;
"what does the standard say" → boost shared).
**Generalized:** model retrieval as **layers** (a shared/global layer + one or
more scoped layers), queried together, fused, source-tagged, with query-adaptive
weighting. Tenancy is just "which scoped layer."
**Plugin:** our **project = Silo**, **global search = Pool over all projects**.
The **Bridge** generalization — a shared layer plus per-project layers, weighted by
query — is a natural evolution of `global_search`, and the unified-db
`project.parent_id` hierarchy is exactly the substrate for it.

### C5 · Provenance & grounding (the trust layer)
**Seen as:** B is built around the finding that RAG tools still hallucinate
17–58%, that up to 57% of citations are *unfaithful* (model answers from memory,
then back-fills a source). Mitigations: **source attribution on every output**,
**require exact quotes**, **enforce inline citations**, **post-hoc attribution
verification** (check each cited claim against the retrieved text), and flag
unverifiable claims `[UNVERIFIED]`. Separates **correctness** from
**groundedness**.
**Generalized:** every retrieved result carries verifiable provenance (source id,
path, span, score, which signal matched); a **grounding verifier** can check that a
generated claim is actually supported by the spans it cites, flagging the rest.
Domain-independent — "source" is a file, a message, or a URL.
**Plugin:** results already include `source/url/score`; what's new is a
**grounding/quote-verification helper** and surfacing *which signal* (dense vs
lexical) produced each hit. High value for any agent built on the retrieval.

### C6 · Confidence scoring & human-in-the-loop routing
**Seen as:** B shows self-rated confidence is unreliable (AUROC ≈ 0.58);
**self-consistency sampling** (agreement across 3–5 generations) plus calibration
works better; present **categorical tiers** (High/Med/Low), and **gate escalation
on confidence × stakes** (auto / review-flagged / human-drafts).
**Generalized:** derive confidence from *agreement and retrieval strength*, not
self-report; expose tiers, not opaque percentages; route low-confidence or
high-stakes results to a human. Applies to any automated pipeline.
**Plugin:** a retrieval-side signal already exists (top rerank score, dense/lexical
agreement, score gap) → a cheap **confidence tier** on each answer; the
human-in-the-loop routing belongs to whatever agent consumes it.

### C7 · Token-budget context assembly
**Seen as:** A trims merged results to a token budget with a real tokenizer before
returning.
**Generalized:** assemble the final context greedily under a token budget,
preferring the highest-value units, deduping by content.
**Plugin:** already specified as the unified-db "budget assembler"; the engine can
gain a `max_tokens` arg that trims reranked results by token count.

### C8 · External structured-reference resolution & validation
**Seen as:** B's PRH **company-data MCP server** — `lookup_by_id`, `search_by_name`,
`validate_active` — resolves and **validates** external entities, with caching and
rate-limit respect; A's `get_project_info` resolves README structure.
**Generalized:** MCP tools that **resolve** an external reference to a canonical
record and **validate** it (exists / current), cache results, and link it back
into the store. Domain-independent — the "registry" is any authoritative source.
**Plugin:** maps directly to the unified-db `reference` table + the daemon's
`extract_references`; the new surface is *resolver/validator* MCP tools and a
**citation engine** that checks references in output against the index.

### C9 · Capability & environment guards
**Seen as:** A gates the whole MCP/index surface behind `NODE_ENV==='development'`
at three layers (route, server, client) — defense in depth.
**Generalized:** tools that mutate or expose data declare an **enablement guard**
(environment, scope, allow-list) enforced before any logic runs, in depth.
**Plugin:** our MCP tools are read-mostly, but `ingest`/`reindex`/`create_project`
mutate; an opt-in guard (e.g. `VINDEX_READONLY`, allow-listed roots) is a sound,
generic safety addition.

### C10 · Incremental ingestion from authoritative sources
**Seen as:** B ingests bulk ZIPs once, then **incremental daily updates via REST**;
caches with TTL.
**Generalized:** a first **bulk** load plus **incremental** change-driven updates,
content-hash diffed, on a schedule.
**Plugin:** already shipped — the background daemon's source/chat feeders are
exactly this pattern.

### C11 · Reasoning scaffolds & knowledge-boundary prompts
**Seen as:** B's system-prompt layers (role, jurisdiction, **"answer ONLY from
retrieved texts, never fabricate references"**, citation format, output structure)
and IRAC / Chain-of-Logic decomposition.
**Generalized:** ship **reusable prompt scaffolds** — a knowledge-boundary
preamble that forbids ungrounded claims, a structured-decomposition template, and
a citation-format contract — as MCP *Prompts* / skill assets, parameterized by
domain.
**Plugin:** the skill could expose a small library of grounding/decomposition
prompt templates that any agent pairs with the retrieval tools.

---

## Mapping to the plugin

| Capability | Status | Where it lands |
| --- | --- | --- |
| C1 typed units | **shipped** | `src/chunk/units.ts`; `unit_type` + `kinds` filter in search |
| C2 context-prefix chunking | **shipped** | context prefix in `src/db/ingest.ts` / `src/chunk/chunker.ts` |
| C3 hybrid dense+sparse + RRF | **shipped** | `src/search/search.ts` (pgvector + Postgres FTS + RRF) |
| C4 layered/Bridge orchestration | **shipped** | `src/search/orchestration.ts`; global-search layers |
| C5 provenance & grounding | **shipped** | `src/search/grounding.ts`; result `signals` |
| C6 confidence tiers | **shipped** | `confidenceTier` in `src/search/grounding.ts` |
| C7 token-budget assembly | **shipped** | `src/search/assemble.ts`; `--max-tokens` |
| C8 reference resolve/validate | **shipped** | `src/search/references.ts`; `validate_citations` / `resolve_reference` MCP tools |
| C9 capability guards | **shipped** | `src/guards.ts`; `VINDEX_READONLY` / `VINDEX_ALLOW_ROOTS` |
| C10 incremental ingestion | **shipped** | diff-by-hash `src/db/ingest.ts` + daemon feeders |
| C11 prompt scaffolds | **shipped** | `src/prompts.ts`; `vectors prompt` |

> All eleven capabilities are implemented in the TypeScript engine (`src/`),
> wired into the CLI and the 13-tool MCP server. The store is PostgreSQL +
> pgvector; the sparse retrieval leg is Postgres full-text search (not a BM25
> sidecar), and embeddings/reranking are pure JS/WASM via `@xenova/transformers`.

## Recommended build order

1. **C3 hybrid retrieval + C2 context-prefix chunking** — one coherent,
   self-contained, fully domain-agnostic upgrade to the live engine that measurably
   improves precision *and* exact-match recall. Highest leverage, lowest blast
   radius. *(Recommended first.)*
2. **C5 provenance/grounding + C6 confidence tiers** — make every result carry its
   matched-signal provenance and a confidence tier; add a quote-verification helper.
3. **C4 Bridge orchestration** — a shared layer + query-adaptive weighting over the
   project hierarchy.
4. **C8 resolver/validator tools + citation engine**, then **C1 typed units**,
   **C9 guards**, **C11 prompt scaffolds**.

Everything above is corpus-agnostic: substitute "statute §" or "TypeScript symbol"
with any structural unit and the design is unchanged.
