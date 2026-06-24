/**
 * Shared domain types. These mirror the rows of unified-knowledge-db.sql and the
 * result shapes the old Python `vector_index.py` returned, so every module ports
 * against one stable contract.
 */

export type ChunkStrategy = 'markdown' | 'code' | 'text' | 'auto'

export type UnitType =
  | 'section' |
  'symbol' |
  'definition' |
  'code' |
  'text'

export interface ChunkConfig {
  strategy:        ChunkStrategy;
  min_chars:       number;
  max_chars:       number;
  overlap:         number;
  context_prefix?: boolean;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  strategy:       'auto',
  min_chars:      200,
  max_chars:      1500,
  overlap:        150,
  context_prefix: true,
}

/** A configured ingest source attached to a project. */
export interface SourceConfig {
  id:        string;
  type:      'dir' | 'repo';
  path:      string;
  globs:     string[];
  base_url?: string | null;
}

/** A row of the `project` table, joined with its embedding space. */
export interface ProjectRow {
  id:           string;
  name:         string;
  parent_id:    string | null;
  root_path:    string | null;
  embed_model:  string;
  rerank_model: string;
  space_id:     string;
  chunk_cfg:    ChunkConfig;
}

/** The embedding-space registry row (model, dim, metric, physical table). */
export interface EmbeddingSpace {
  id:         string;
  model:      string;
  dim:        number;
  metric:     'cosine' | 'ip' | 'l2';
  table_name: string;
}

/** A single produced chunk before it is persisted. */
export interface ProducedChunk {
  symbol?:   string | null;
  ordinal:   number;
  title:     string | null;
  text:      string;
  url:       string | null;
  unit_type: UnitType;
}

/** A retrieval hit, carrying the fusion/rerank signals the assembler needs. */
export interface SearchHit {
  chunk_id:    string;
  document_id: string;
  project:     string;
  ordinal:     number;
  title:       string | null;
  text:        string;
  url:         string | null;
  unit_type:   UnitType | null;

  /** Cosine similarity from the dense (pgvector) leg, 0..1. */
  dense: number;

  /** BM25/FTS rank score from the sparse leg (Postgres ts_rank). */
  sparse: number;

  /** Reciprocal-rank-fusion score. */
  rrf: number;

  /** Cross-encoder rerank score when reranking was applied. */
  rerank?: number;

  /** Final ordering score actually used. */
  score: number;
}

export type ConfidenceTier = 'high' | 'medium' | 'low'

export interface SearchResult {
  query:      string;
  project:    string;
  hits:       SearchHit[];
  confidence: ConfidenceTier;

  /** True when the dense and sparse legs agreed on the top hit. */
  agreement: boolean;
}
