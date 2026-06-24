# tests

`bun test` — fast, model-free unit tests run directly on Bun (no Python, no
extra dependencies, no network or database). The suite lives in a single file,
[`tests/unit.test.ts`](../../../tests/unit.test.ts) at the repo root.

```bash
bun test                  # run everything
bun test tests/unit.test.ts
```

## What's covered

All tests are instant and model-free — they exercise the pure logic, not the
embedder/reranker or Postgres. Four `describe` blocks:

- **`chunker`** (`src/chunk/chunker.ts`) — markdown splits at headings; `auto`
  strategy picks the code chunker for `.ts` files.
- **`units`** (`src/chunk/units.ts`) — `classifyUnit` tags a markdown heading as
  `section`, always returns a valid unit type, and classifies source as
  `code`/`symbol`/`definition`.
- **`grounding`** (`src/search/grounding.ts`) — `confidenceTier` is `low` on
  empty and `high` on a strong reranked score with dense/sparse agreement;
  `verifyClaim` accepts a lexically-grounded claim and rejects an unsupported one.
- **`assemble`** (`src/search/assemble.ts`) — `assembleWithinBudget` keeps hits
  within a token budget.

There is no separate model-backed or integration suite; the model and database
paths are validated end-to-end via `vectors doctor` and real `vectors index` /
`vectors search` runs.
