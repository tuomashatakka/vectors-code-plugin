# AGENTS.md

Orientation for agents working on **vectors-plugin** — a global, local,
project-partitioned semantic RAG store. TypeScript run directly on Bun (no build
step), backed by PostgreSQL + pgvector. Embeddings and reranking are pure
JS/WASM (`@xenova/transformers`, ONNX) — **no Python anywhere**.

> **`spec.md` (repo root) is the source of truth.** It is an exhaustive,
> example-rich specification of the data model, retrieval pipeline, daemon, MCP
> tools, CLI, and config. Read it before making non-trivial changes; keep it in
> sync when behavior changes.

## Build / test / lint

```bash
bun install                       # install dependencies
bun run typecheck                 # tsc --noEmit -p tsconfig.json
bun run lint                      # eslint src hooks (ZERO warnings enforced)
bun run lint:fix                  # eslint --fix
bun test                          # bun test (tests/)
bun src/cli/index.ts doctor       # diagnose Bun, DSN, Postgres, pgvector, schema, daemon
```

Requirements: Bun ≥ 1.2, PostgreSQL 16 + pgvector ≥ 0.7. Spin up a throwaway DB:
`docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vectors -p 5432:5432 pgvector/pgvector:pg16`
then `export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors`.

## Module map (`src/`)

| Path | Responsibility |
| --- | --- |
| `cli/` | CLI registry: `index.ts` (dispatch + `--help`), `kit.ts` (command type, arg parse, result print), `commands/*.ts` (one module per command group). |
| `db/` | `pool.ts` (pg pool, `q`/`q1`/`tx`/`toVector`), `schema.ts` (apply DDL + migrations + `ensureSpace`), `projects.ts` (registry + cwd auto-resolution), `ingest.ts` (diff-by-hash ingest + AST chunks + import edges), `types.ts` (shared domain types). |
| `chunk/` | `chunker.ts` (markdown/code/text/auto line+char windows), `ast.ts` (tree-sitter WASM per-symbol chunks + import graph), `units.ts` (`unit_type` classifier). |
| `embed/` | `embedder.ts` (feature-extraction, mean-pool + L2-norm), `rerank.ts` (cross-encoder sequence classification). |
| `search/` | `search.ts` (hybrid dense+sparse RRF + rerank + confidence), `grounding.ts` (confidence tiers, claim verify), `references.ts` (citation extraction/validation), `assemble.ts` (token-budget assembly), `orchestration.ts` (Bridge-pattern layer weights). |
| `intents/` | `store.ts` — Postgres-backed intent memory (record/recall/resolve/grade). |
| `daemon/` | `daemon.ts` (supervisor), `feeders/chat.ts` + `feeders/source.ts`, `worker.ts` (digest-job drain). |
| `mcp/` | `server.ts` — stdio MCP server, 13 tools. |
| `viewer/` | `server.ts` (3D synapse viewer HTTP + JSON API, PCA), `make_demo.ts` (standalone demo export). |
| `config.ts` | All env config. `VINDEX_*` canonical; `UKDB_*` accepted as deprecated aliases via `envAny()`. |
| `guards.ts` | `VINDEX_READONLY` / `VINDEX_ALLOW_ROOTS` capability guards. |
| `transcript.ts` | Tolerant JSONL transcript parsing (daemon chat feeder + intent grader). |
| `prompts.ts` | Grounding / reasoning prompt scaffolds. |

`hooks/` holds the Claude Code `UserPromptSubmit` + `Stop` hooks (intent memory).
`references/unified-knowledge-db.sql` is the full DDL. `skills/vector-index/`
ships the skill (SKILL.md, daemon tooling, viewer asset, reference docs).

## Conventions

- **No semicolons** (ASI). Single quotes. 2-space indent.
- **Aligned object literals / interfaces** — colons line up within a block.
- `.ts` import extensions everywhere (`import { q } from './pool.ts'`); enabled
  by `allowImportingTsExtensions` + `verbatimModuleSyntax`.
- ESLint config is `@tuomashatakka/eslint-config`; **zero warnings** is the bar.
  Localized rule exceptions go through inline `eslint-disable-*` comments with a
  reason (see the `complexity` disables on routers/parsers).
- Strict TypeScript (`strict: true`, `noEmit`). Run `bun run typecheck` before
  pushing.
- Mutating operations (`ingest`/`reindex`/`create`/`add-source`) call
  `assertWritable` / `assertAllowedRoot` first — keep that guard ordering.
