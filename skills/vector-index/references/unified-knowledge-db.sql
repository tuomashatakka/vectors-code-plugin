-- =============================================================================
-- Unified Knowledge Database — schema (DDL sketch)
--
-- One PostgreSQL database that unifies, and cross-references, four things that
-- used to live in separate per-project zvec collections (or nowhere at all):
--
--   1. vector data        — chunk embeddings (pgvector, replacing zvec)
--   2. chat memory/history — sessions + messages (new)
--   3. external references — URLs, Google Drive, Notion, citations (new)
--   4. own content         — full document/codebase text + chunks
--
-- plus a 4-level memory abstraction ladder, a background-digest job queue driven
-- by a local Ollama worker, a constantly-learning fact store, and the metadata a
-- token-budgeted retrieval assembler needs.
--
-- Target: PostgreSQL 16, pgvector >= 0.7. Embeddings are produced in the app
-- layer by sentence-transformers (default all-MiniLM-L6-v2, 384-dim) and reranked
-- by a cross-encoder, exactly as today; Postgres is the store, Ollama does only
-- autonomous "haiku-level" digest tasks. See unified-knowledge-db-spec.md for the
-- design rationale behind every table here.
--
-- Apply against a throwaway instance to validate:
--   docker run --rm -e POSTGRES_PASSWORD=x -p 5432:5432 pgvector/pgvector:pg16
--   psql "postgresql://postgres:x@localhost:5432/postgres" -f unified-knowledge-db.sql
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Extensions & enums
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: vector type + HNSW
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram index for uri / lexical dedupe assist

-- What a (kind, id) pair can point at. Used by the polymorphic link table and by
-- memory_node anchors.
CREATE TYPE node_kind AS ENUM ('chunk', 'message', 'memory', 'reference', 'fact', 'summary');

-- The exactness ladder: L0 = verbatim content, L3 = vaguest concept.
CREATE TYPE mem_level AS ENUM ('L0', 'L1', 'L2', 'L3');

-- Cross-reference relationship semantics (siblings, citations, dedupe, ...).
CREATE TYPE link_kind AS ENUM (
  'sibling', 'related', 'cites', 'derived_from',
  'mentions', 'duplicate_of', 'parent_child'
);

-- Digest job lifecycle.
CREATE TYPE job_state AS ENUM ('queued', 'leased', 'done', 'failed', 'dead');

-- External reference flavours.
CREATE TYPE ref_kind AS ENUM ('url', 'gdrive', 'notion', 'github', 'citation', 'file');


-- ----------------------------------------------------------------------------
-- Embedding-space registry
--
-- pgvector columns are FIXED-dimension and an HNSW index can only be built on a
-- fixed-dim column, but embed_model (hence dim) varies per project. Each distinct
-- (model, dim, metric) is one "space" backed by its own physical emb_<name> table
-- (see the template below). Everything that has a vector references it indirectly
-- by (space_id, embedding_id), keeping the rest of the schema dimension-agnostic.
-- Most installs have exactly one space (MiniLM / 384).
-- ----------------------------------------------------------------------------
CREATE TABLE embedding_space (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model       text NOT NULL,
  dim         integer NOT NULL,
  metric      text NOT NULL DEFAULT 'cosine',     -- cosine | ip | l2
  table_name  text NOT NULL,                       -- physical table, e.g. 'emb_minilm_384'
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model, dim, metric)
);


-- ----------------------------------------------------------------------------
-- Per-space embedding table — TEMPLATE
--
-- Instantiated once per space by the app when a new model first appears; <dim>
-- and the table name come from the embedding_space row. Embeddings are L2-
-- normalized at ingest, so cosine == inner product. content_hash de-duplicates
-- identical text within a space: a chunk and a verbatim chat message with the
-- same text share one vector row. Below is the concrete default-space instance.
-- ----------------------------------------------------------------------------
CREATE TABLE emb_minilm_384 (
  embedding_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      uuid NOT NULL REFERENCES embedding_space(id),
  content_hash  bytea NOT NULL,                    -- sha256 of the embedded text
  token_count   integer,
  embedding     vector(384) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (space_id, content_hash)
);
CREATE INDEX emb_minilm_384_hnsw
  ON emb_minilm_384 USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);


-- ----------------------------------------------------------------------------
-- Projects — multi-project structure (hierarchy + siblings)
--
-- parent_id gives a parent/child hierarchy (walk with a recursive CTE). Sibling
-- and "related" relationships are many-to-many and cross-project, so they live in
-- the link table (relation = 'sibling' | 'related'), not as columns here. Content
-- is project-tagged for fast filtered ANN but NOT hard-isolated: global search and
-- cross-project links remain first-class.
-- ----------------------------------------------------------------------------
CREATE TABLE project (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,              -- == the old zvec collection name
  parent_id     uuid REFERENCES project(id) ON DELETE SET NULL,
  root_path     text,                              -- anchor for cwd auto-resolution
  embed_model   text NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  rerank_model  text NOT NULL DEFAULT 'cross-encoder/ms-marco-MiniLM-L6-v2',
  space_id      uuid NOT NULL REFERENCES embedding_space(id),
  chunk_cfg     jsonb NOT NULL DEFAULT
                  '{"strategy":"auto","min_chars":200,"max_chars":1500,"overlap":150}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_parent_idx ON project (parent_id);
CREATE INDEX project_root_idx   ON project (root_path text_pattern_ops);


-- ----------------------------------------------------------------------------
-- Own content: documents + chunks (feature 4)
--
-- One document per source file (full content stored). One chunk per embedded
-- slice. The old stable id "v"+sha256(source_id\0source\0chunk)[:30] is replaced
-- by content_hash + UNIQUE(document_id, ordinal): re-ingest UPSERTs instead of
-- duplicating. project_id is denormalized onto chunk so a filtered ANN query stays
-- single-table.
-- ----------------------------------------------------------------------------
CREATE TABLE document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_id     text NOT NULL,                     -- which configured Source produced it
  rel_path      text NOT NULL,                     -- path relative to the source root
  title         text,
  url           text,                              -- reconstructed public URL (or NULL)
  content       text,                              -- full file content
  content_hash  bytea NOT NULL,                    -- whole-file hash -> skip unchanged files
  mtime         timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_id, rel_path)
);
CREATE INDEX document_project_idx ON document (project_id);

CREATE TABLE chunk (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,  -- denormalized
  ordinal       integer NOT NULL,                  -- the old "chunk" field
  title         text,
  text          text NOT NULL,                     -- stored chunk text (as today)
  url           text,
  content_hash  bytea NOT NULL,
  token_count   integer,
  space_id      uuid NOT NULL REFERENCES embedding_space(id),
  embedding_id  uuid NOT NULL,                     -- -> emb_<space>.embedding_id (app-enforced)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX chunk_project_idx ON chunk (project_id);
CREATE INDEX chunk_hash_idx    ON chunk (content_hash);


-- ----------------------------------------------------------------------------
-- Chat memory: sessions + messages (feature 2, new)
--
-- A raw message is an L0 (exact) node just like a chunk, addressable from the
-- memory ladder and the link table. embedding_id is nullable until the digest
-- worker embeds it.
-- ----------------------------------------------------------------------------
CREATE TABLE session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES project(id) ON DELETE SET NULL,
  title         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);

CREATE TABLE message (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES project(id) ON DELETE SET NULL,   -- denormalized
  role          text NOT NULL,                     -- user | assistant | tool
  seq           integer NOT NULL,
  text          text NOT NULL,
  content_hash  bytea NOT NULL,
  token_count   integer,
  space_id      uuid REFERENCES embedding_space(id),
  embedding_id  uuid,                              -- nullable until digested
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX message_session_idx ON message (session_id);
CREATE INDEX message_project_idx ON message (project_id);


-- ----------------------------------------------------------------------------
-- External references (feature 3)
--
-- Global (not project-scoped): the same Notion page or URL can be cited from many
-- projects. The link table connects a reference to whoever mentions/cites it.
-- ----------------------------------------------------------------------------
CREATE TABLE reference (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          ref_kind NOT NULL,
  uri           text NOT NULL,                     -- canonical: URL, gdrive id, notion id, ...
  title         text,
  snippet       text,                              -- cached excerpt if fetched
  content_hash  bytea,
  metadata      jsonb NOT NULL DEFAULT '{}',       -- mime, author, last_fetched, ...
  space_id      uuid REFERENCES embedding_space(id),
  embedding_id  uuid,                              -- optional: embed title+snippet
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, uri)
);
CREATE INDEX reference_uri_trgm ON reference USING gin (uri gin_trgm_ops);


-- ----------------------------------------------------------------------------
-- Constantly-learning memory: facts (requirement 4)
--
-- Extracted intel worth keeping for the future, distinct from the abstraction
-- ladder. Reinforcement bumps hit_count/salience on use; decay is COMPUTED, not a
-- destructive rewrite:
--   effective_salience = salience * exp(-lambda * age) + beta * ln(1 + hit_count)
-- Near-duplicates are collapsed via duplicate_of links and status='superseded',
-- never hard-deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE fact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES project(id) ON DELETE SET NULL,   -- NULL = global / user-level
  fact_type     text NOT NULL,                     -- fact | preference | decision | entity
  statement     text NOT NULL,
  content_hash  bytea NOT NULL,
  confidence    real NOT NULL DEFAULT 0.5,         -- 0..1, from the extractor
  salience      real NOT NULL DEFAULT 0.5,         -- decays over time, bumped on reuse
  hit_count     integer NOT NULL DEFAULT 0,        -- reinforcement signal
  last_used_at  timestamptz,
  space_id      uuid REFERENCES embedding_space(id),
  embedding_id  uuid,
  status        text NOT NULL DEFAULT 'active',    -- active | superseded | retracted
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, content_hash)
);
CREATE INDEX fact_salience_idx ON fact (project_id, status, salience DESC);


-- ----------------------------------------------------------------------------
-- Memory abstraction ladder L0..L3 (feature 2)
--
--   L0 = exact content, anchored to a chunk or message (verbatim, no summary)
--   L1 = per-document / per-exchange summary
--   L2 = topic / cluster
--   L3 = vague concept / theme (top, vaguest)
--
-- Higher levels are DERIVED by Ollama from lower nodes via the derivation DAG.
-- Updatability is explicit: each derivation records the child's content_hash at
-- build time; source_fingerprint (hash of the sorted child hashes) + is_stale +
-- version let staleness propagate up and trigger bottom-up regeneration. Raw L0
-- content is NEVER mutated by a rebuild — that decoupling is the headline
-- guarantee.
-- ----------------------------------------------------------------------------
CREATE TABLE memory_node (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid REFERENCES project(id) ON DELETE CASCADE,  -- NULL = cross-project
  level               mem_level NOT NULL,
  -- L0 anchors to exact content (exactly one of these set); L1+ leave them NULL:
  anchor_kind         node_kind,                   -- 'chunk' | 'message'
  anchor_id           uuid,
  -- derived nodes (L1+) carry generated prose:
  summary             text,
  label               text,                        -- topic / concept name (L2/L3)
  content_hash        bytea NOT NULL,              -- hash of summary OR anchor text
  token_count         integer,
  space_id            uuid REFERENCES embedding_space(id),
  embedding_id        uuid,                        -- every node is embeddable/searchable
  -- versioning + staleness (the decoupling):
  version             integer NOT NULL DEFAULT 1,
  is_stale            boolean NOT NULL DEFAULT false,
  source_fingerprint  bytea,                       -- hash of the set of child hashes built from
  generator           text,                        -- e.g. 'ollama:llama3.1:8b'
  generated_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((level = 'L0') = (anchor_id IS NOT NULL)) -- L0 <=> anchored; L1+ <=> derived
);
CREATE INDEX memory_level_idx  ON memory_node (project_id, level);
CREATE INDEX memory_stale_idx  ON memory_node (is_stale) WHERE is_stale;
CREATE INDEX memory_anchor_idx ON memory_node (anchor_kind, anchor_id);

-- A derived node is built FROM a set of lower nodes. child_hash freezes the
-- child's content_hash at derivation time so staleness is a cheap comparison.
CREATE TABLE derivation (
  parent_id   uuid NOT NULL REFERENCES memory_node(id) ON DELETE CASCADE,  -- higher/derived
  child_id    uuid NOT NULL REFERENCES memory_node(id) ON DELETE CASCADE,  -- lower/source
  child_hash  bytea NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX derivation_child_idx ON derivation (child_id);


-- ----------------------------------------------------------------------------
-- Cross-reference model: one polymorphic link table
--
-- Chosen over typed join tables because the requirement is open-ended and N-way
-- (chunks, messages, references, memory nodes and facts all link to each other,
-- across projects, with several relationship semantics). project_id NULL = a
-- cross-project link, which is allowed. The cost — no single-column FK
-- enforcement — is mitigated by the node_kind enum, a validation trigger, a
-- periodic GC of orphans, and app-only writes. The abstraction DAG keeps its own
-- `derivation` table because it additionally stores child_hash for staleness;
-- link is for everything else and for surfacing cross-references at retrieval.
-- ----------------------------------------------------------------------------
CREATE TABLE link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  src_kind    node_kind NOT NULL,
  src_id      uuid NOT NULL,
  dst_kind    node_kind NOT NULL,
  dst_id      uuid NOT NULL,
  relation    link_kind NOT NULL,
  weight      real NOT NULL DEFAULT 1.0,           -- similarity / confidence of the link
  project_id  uuid REFERENCES project(id),         -- NULL = cross-project link
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_kind, src_id, dst_kind, dst_id, relation)
);
CREATE INDEX link_src_idx ON link (src_kind, src_id, relation);
CREATE INDEX link_dst_idx ON link (dst_kind, dst_id, relation);


-- ----------------------------------------------------------------------------
-- Background digest job queue (feature 3) — consumed by a local Ollama worker
--
-- payload carries ids, never blobs. dedupe_key collapses redundant enqueues. Task
-- catalog (all haiku-level, all on local Ollama):
--   embed, summarize, extract_concepts, cluster_topics,
--   extract_references, extract_facts, dedupe, rebuild_abstraction
-- See the worker contract in the spec. Cascades are data-driven: new chunk ->
-- embed -> extract_* -> summarize -> cluster.
-- ----------------------------------------------------------------------------
CREATE TABLE digest_job (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task          text NOT NULL,
  payload       jsonb NOT NULL,
  priority      integer NOT NULL DEFAULT 100,      -- lower = sooner
  state         job_state NOT NULL DEFAULT 'queued',
  dedupe_key    text UNIQUE,                        -- collapse duplicate enqueues
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  lease_until   timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_ready_idx ON digest_job (priority, id) WHERE state = 'queued';

-- Worker claim (safe for many concurrent workers): see spec §8.
--   UPDATE digest_job SET state='leased', attempts=attempts+1,
--          lease_until = now() + interval '5 min', updated_at = now()
--   WHERE id = (
--     SELECT id FROM digest_job
--     WHERE state='queued' AND priority <= $1
--     ORDER BY priority, id
--     FOR UPDATE SKIP LOCKED
--     LIMIT 1)
--   RETURNING *;
-- A reaper requeues rows whose lease_until < now() (crashed workers).


-- ----------------------------------------------------------------------------
-- Enqueue on new content: LISTEN/NOTIFY for latency + a polling safety net.
--
-- NOTIFY is fire-and-forget (a worker mid-task or just-connected can miss it), so
-- job_ready_idx polling is the source of truth and NOTIFY is only the optimizer.
-- This trigger enqueues an `embed` job and pings the 'digest' channel; the worker
-- chains the rest (extract_*, summarize, cluster) data-driven.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_digest() RETURNS trigger AS $$
DECLARE
  kind text := TG_ARGV[0];   -- 'chunk' | 'message' | 'reference'
BEGIN
  INSERT INTO digest_job (task, payload, dedupe_key)
  VALUES (
    'embed',
    jsonb_build_object('node_kind', kind, 'id', NEW.id),
    'embed:' || kind || ':' || NEW.id::text
  )
  ON CONFLICT (dedupe_key) DO NOTHING;
  PERFORM pg_notify('digest', kind || ':' || NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chunk_enqueue_digest
  AFTER INSERT ON chunk
  FOR EACH ROW EXECUTE FUNCTION enqueue_digest('chunk');

CREATE TRIGGER message_enqueue_digest
  AFTER INSERT ON message
  FOR EACH ROW EXECUTE FUNCTION enqueue_digest('message');

CREATE TRIGGER reference_enqueue_digest
  AFTER INSERT ON reference
  FOR EACH ROW EXECUTE FUNCTION enqueue_digest('reference');
