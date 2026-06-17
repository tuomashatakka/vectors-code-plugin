#!/usr/bin/env python3
"""
Model-backed integration tests for the project-partitioned RAG store.

These exercise the real pipeline end to end — embedding, zvec storage, cross-
encoder rerank, per-project + global search, cwd resolution to a live project,
and reindex idempotency — over a tiny synthetic two-project corpus in an
isolated $VINDEX_HOME.

They load the local sentence-transformers models (cached under
~/.cache/huggingface), so they take a few seconds. Skip them with:

    VINDEX_SKIP_MODEL_TESTS=1 ./.venv/bin/python -m unittest discover -s tests

Run just these:
    ./.venv/bin/python tests/test_integration.py
"""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import vector_index as vi  # noqa: E402

SKIP = os.environ.get("VINDEX_SKIP_MODEL_TESTS") == "1"

CORPUS = {
    "scene": {
        "flock.md": (
            "# Flock evolution loop\n"
            "The flock picks ideas from IDEAS.md on a 15-minute cadence using "
            "qwen2.5-coder. Deep evolution uses devstral every 3 hours.\n"
        ),
        "propmesh.md": (
            "# Prop mesh framework\n"
            "Registry-driven prop mesh generation with types, topology, bases, "
            "modifiers and a builder. Every mesh uses a deterministic seeded RNG "
            "so geometry output is fully reproducible.\n"
        ),
    },
    "portfolio": {
        "hbd.md": (
            "# Hummingbird Design system\n"
            "Near-monochrome palette, Novecento Sans Wide, squared corners and a "
            "first-person voice across a Vite and Bun zero-framework static site.\n"
        ),
        "map.md": (
            "# Viertola map\n"
            "Generated from live OSM and Overpass data with an equirectangular "
            "projection in a monochrome hairline style.\n"
        ),
    },
}


@unittest.skipIf(SKIP, "VINDEX_SKIP_MODEL_TESTS=1")
class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._store = tempfile.mkdtemp(prefix="vindex-itest-store-")
        cls._corpus = Path(tempfile.mkdtemp(prefix="vindex-itest-corpus-")).resolve()
        cls._old_home = vi.HOME
        vi.HOME = Path(cls._store)
        for proj, files in CORPUS.items():
            root = cls._corpus / proj
            root.mkdir(parents=True)
            for fn, body in files.items():
                (root / fn).write_text(body)
            p = vi.Project.create(proj, root=str(root), chunk=vi.ChunkConfig(strategy="markdown"))
            p.add_source(vi.Source(id=proj, type="dir", path=str(root), globs=["**/*.md"]))
            p.ingest()

    @classmethod
    def tearDownClass(cls):
        vi.HOME = cls._old_home
        shutil.rmtree(cls._store, ignore_errors=True)
        shutil.rmtree(cls._corpus, ignore_errors=True)

    # -- ingest / status ----------------------------------------------------
    def test_ingest_populated_both_projects(self):
        self.assertEqual(sorted(vi.list_projects()), ["portfolio", "scene"])
        for name in ("scene", "portfolio"):
            st = vi.Project.load(name).status()
            self.assertEqual(st["state"], "ready")
            self.assertEqual(st["doc_count"], 2)
            self.assertEqual(st["project"], name)
            self.assertEqual(st["embed_dim"], 384)

    # -- per-project search -------------------------------------------------
    def test_project_search_tags_and_ranks(self):
        res = vi.Project.load("scene").search("deterministic seeded geometry", topk=2)
        self.assertEqual(res["project"], "scene")
        self.assertTrue(res["reranked"])
        self.assertTrue(res["results"])
        top = res["results"][0]
        self.assertEqual(top["project"], "scene")
        self.assertEqual(top["source"], "propmesh.md")
        self.assertTrue(top["snippet"])
        self.assertIn("rerank_score", top)

    def test_search_result_self_contained_text(self):
        res = vi.Project.load("portfolio").search("squared corners typography", topk=1)
        self.assertIn("text", res["results"][0])
        self.assertTrue(len(res["results"][0]["text"]) > 0)

    # -- cwd resolution to a live project -----------------------------------
    def test_resolve_loads_correct_project(self):
        proj = vi.Project.resolve(cwd=str(self._corpus / "scene"))
        self.assertEqual(proj.name, "scene")
        res = proj.search("flock evolution cadence", topk=1)
        self.assertEqual(res["results"][0]["project"], "scene")

    # -- global search ------------------------------------------------------
    def test_global_search_merges_tags_and_reranks(self):
        res = vi.global_search("monochrome squared-corner design system", topk=3)
        self.assertEqual(res["scope"], "global")
        self.assertTrue(res["reranked"])
        self.assertEqual(sorted(res["projects"]), ["portfolio", "scene"])
        self.assertTrue(all("project" in r for r in res["results"]))
        # the design query should surface the portfolio project on top
        self.assertEqual(res["results"][0]["project"], "portfolio")
        # no internal vectors leak into the payload
        self.assertTrue(all("_vec" not in r for r in res["results"]))

    def test_global_search_subset(self):
        res = vi.global_search("anything", topk=5, projects=["scene"])
        self.assertEqual(res["projects"], ["scene"])
        self.assertTrue(all(r["project"] == "scene" for r in res["results"]))

    # -- reindex idempotency (stable doc ids) -------------------------------
    def test_reindex_is_idempotent(self):
        before = vi.Project.load("scene").status()["doc_count"]
        vi.Project.load("scene").ingest(rebuild=True)
        after = vi.Project.load("scene").status()["doc_count"]
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
