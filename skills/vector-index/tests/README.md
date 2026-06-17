# tests

Stdlib `unittest` — no extra dependencies beyond the skill's `.venv`.

```bash
cd skills/vector-index
PY=./.venv/bin/python

# everything
$PY -m unittest discover -s tests -v

# fast, model-free units only (chunking, config, project resolution, sources)
$PY -m unittest tests.test_units -v

# model-backed integration only (ingest / search / global / reindex)
$PY tests/test_integration.py

# run units only in a model-less CI box (skips the integration suite)
VINDEX_SKIP_MODEL_TESTS=1 $PY -m unittest discover -s tests
```

## What's covered

`test_units.py` (instant, no models):
- chunking strategies (`markdown` heading splits, sliding line/char windows, `auto`)
- `Source` glob matching + `node_modules`/`.git` exclusion + URL templating
- `IndexConfig` save/load round-trip, including the new `root` field and
  tolerance for legacy pre-`root` configs
- **project resolution precedence** — `$VINDEX_PROJECT` pin, nearest-root match,
  nested longest-root-wins, `.git`/`.vindex` markers, and the default fallback

`test_integration.py` (loads cached sentence-transformers models):
- ingest populates each project; `status` reports `ready` + correct doc counts
- per-project search reranks and tags every hit with its project
- results carry self-contained stored `text`
- `Project.resolve(cwd=...)` loads the right project and searches it
- `global_search` merges across projects, tags by project, reranks the union,
  honours a `projects=[...]` subset, and never leaks internal `_vec`
- reindex is idempotent (stable, content-addressed doc ids)
