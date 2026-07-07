# tests

`bun test` — fast, model-free unit tests run directly on Bun (no Python, no
extra dependencies, no network or database). The suite lives in two files at
the repo root: [`tests/unit.test.ts`](../../../tests/unit.test.ts) and
[`tests/viewer.test.ts`](../../../tests/viewer.test.ts).

```bash
bun test                  # run everything
bun test tests/unit.test.ts
bun test tests/viewer.test.ts
```

## What's covered

All tests are instant and model-free — they exercise the pure logic, not the
embedder/reranker or Postgres.

`unit.test.ts`, four `describe` blocks:

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

`viewer.test.ts` (`src/viewer/static.ts`), three `describe` blocks:

- **`resolveAsset`** — `/` and `/index.html` resolve to `index.html`; nested
  paths resolve inside the asset dir; traversal attempts (raw `..`, encoded
  `%2e%2e`, `//`, mixed `../`) and malformed input (embedded NUL, backslashes,
  bad percent-encoding) are all rejected.
- **`contentTypeFor`** — every known extension maps to its MIME type; unknown
  extensions fall back to `application/octet-stream`.
- **`asset dir parity`** — `assets/viewer/` and
  `skills/vector-index/assets/viewer/` list the same files and are
  byte-identical (sha256), enforcing what `scripts/sync-assets.ts` maintains.

There is no separate model-backed or integration suite; the model and database
paths are validated end-to-end via `vectors doctor` and real `vectors index` /
`vectors search` runs.
