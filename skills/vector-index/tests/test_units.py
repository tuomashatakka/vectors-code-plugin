#!/usr/bin/env python3
"""
Fast, model-free unit tests for vector_index.

These cover the parts that need no embedding model and therefore run in
milliseconds: chunking strategies, config (de)serialization, source matching /
URL templating, and — most importantly — the project-resolution precedence that
is the whole point of the project-partitioned redesign.

Run:
    ./.venv/bin/python -m unittest discover -s tests -v
    ./.venv/bin/python tests/test_units.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import vector_index as vi  # noqa: E402


class TempHomeTest(unittest.TestCase):
    """Base class: isolate $VINDEX_HOME and the resolution env per test."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="vindex-test-")
        self._old_home = vi.HOME
        self._old_default = vi.DEFAULT_PROJECT
        vi.HOME = Path(self._tmp)
        vi.DEFAULT_PROJECT = "default"
        self._old_pin = os.environ.pop("VINDEX_PROJECT", None)

    def tearDown(self):
        vi.HOME = self._old_home
        vi.DEFAULT_PROJECT = self._old_default
        if self._old_pin is not None:
            os.environ["VINDEX_PROJECT"] = self._old_pin
        else:
            os.environ.pop("VINDEX_PROJECT", None)
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    # helper: register a project purely from config (no model needed)
    def _mkproject(self, name, root=None, sources=None):
        cfg = vi.IndexConfig(name=name, root=root, embed_dim=384, sources=sources or [])
        cfg.save()
        return cfg


class ChunkingTests(unittest.TestCase):
    def test_markdown_splits_on_headings(self):
        text = "# A\n" + ("alpha " * 60) + "\n\n## B\n" + ("beta " * 60)
        chunks = vi.chunk_markdown(text, min_chars=50, max_chars=400)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(any(c.startswith("# A") for c in chunks))
        self.assertTrue(any("## B" in c for c in chunks))

    def test_markdown_short_doc_is_single_chunk(self):
        chunks = vi.chunk_markdown("# Tiny\njust a little text", min_chars=5, max_chars=400)
        self.assertEqual(len(chunks), 1)

    def test_sliding_by_line_overlaps(self):
        text = "\n".join(f"line {i} content here" for i in range(200))
        chunks = vi.chunk_sliding(text, max_chars=300, overlap=60, by_line=True)
        self.assertGreater(len(chunks), 1)
        # every chunk fits (modulo a single very long line)
        self.assertTrue(all(len(c) <= 300 + 60 for c in chunks))

    def test_sliding_char_window(self):
        text = "x" * 1000
        chunks = vi.chunk_sliding(text, max_chars=300, overlap=50, by_line=False)
        self.assertTrue(len(chunks) >= 4)

    def test_chunk_file_auto_picks_strategy(self):
        cfg = vi.ChunkConfig(strategy="auto")
        md = vi.chunk_file("notes.md", "# H\n" + "word " * 80, cfg)
        code = vi.chunk_file("mod.py", "\n".join(f"x{i} = {i}" for i in range(200)), cfg)
        self.assertTrue(md and code)

    def test_title_extraction(self):
        self.assertEqual(vi._title_for("# Hello World\nbody", "f.md"), "Hello World")
        self.assertEqual(vi._title_for("no heading here", "my_file-name.md"), "my file name")


class SourceTests(unittest.TestCase):
    def test_default_globs_match_markdown(self):
        s = vi.Source(id="s")
        self.assertTrue(vi._matches("docs/readme.md", s))

    def test_exclude_node_modules(self):
        s = vi.Source(id="s", globs=["**/*.js"])
        self.assertFalse(vi._matches("node_modules/pkg/index.js", s))

    def test_url_template_strips_ext(self):
        s = vi.Source(id="s", base_url="https://h/docs/{path}.html", strip_ext=True)
        self.assertEqual(vi.url_for(s, "guide/intro.md"), "https://h/docs/guide/intro.html")

    def test_url_none_without_template(self):
        self.assertIsNone(vi.url_for(vi.Source(id="s"), "x.md"))


class ConfigRoundTripTests(TempHomeTest):
    def test_save_and_load_preserves_root_and_sources(self):
        src = vi.Source(id="docs", type="dir", path="/tmp/docs", globs=["**/*.md"])
        self._mkproject("alpha", root="/tmp/alpha", sources=[src])
        loaded = vi.IndexConfig.load("alpha")
        self.assertEqual(loaded.name, "alpha")
        self.assertEqual(loaded.root, "/tmp/alpha")
        self.assertEqual(len(loaded.sources), 1)
        self.assertEqual(loaded.sources[0].id, "docs")

    def test_load_tolerates_pre_project_config_without_root(self):
        # simulate a legacy config.json that predates the `root` field
        d = vi.index_dir("legacy")
        d.mkdir(parents=True)
        (d / "config.json").write_text(
            '{"name": "legacy", "embed_model": "all-MiniLM-L6-v2", '
            '"rerank_model": "x", "embed_dim": 384, '
            '"chunk": {"strategy": "auto"}, "sources": []}'
        )
        loaded = vi.IndexConfig.load("legacy")
        self.assertIsNone(loaded.root)

    def test_list_and_alias(self):
        self._mkproject("a")
        self._mkproject("b")
        self.assertEqual(vi.list_indexes(), ["a", "b"])
        self.assertEqual(vi.list_projects(), ["a", "b"])  # alias

    def test_project_records_shape(self):
        self._mkproject("a", root="/tmp/a")
        recs = vi.project_records()
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["project"], "a")
        self.assertIn("doc_count", recs[0])
        # compare resolved forms to be agnostic about /tmp -> /private/tmp etc.
        self.assertEqual(str(Path(recs[0]["root"]).resolve()), str(Path("/tmp/a").resolve()))


class ResolutionTests(TempHomeTest):
    """The core new behaviour: which project does a cwd resolve to?"""

    def setUp(self):
        super().setUp()
        self.base = Path(tempfile.mkdtemp(prefix="vindex-roots-")).resolve()
        for sub in ("alpha", "beta", "nest", "nest/sub", "alpha/deep", "lonely"):
            (self.base / sub).mkdir(parents=True, exist_ok=True)
        self._mkproject("alpha", root=str(self.base / "alpha"))
        self._mkproject("beta", root=str(self.base / "beta"))
        self._mkproject("outer", root=str(self.base / "nest"))
        self._mkproject("inner", root=str(self.base / "nest" / "sub"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.base, ignore_errors=True)
        super().tearDown()

    def test_pin_wins(self):
        os.environ["VINDEX_PROJECT"] = "pinned"
        self.assertEqual(vi.resolve_project_name(self.base / "alpha"), "pinned")

    def test_root_ancestor_match(self):
        self.assertEqual(vi.resolve_project_name(self.base / "alpha" / "deep"), "alpha")
        self.assertEqual(vi.resolve_project_name(self.base / "beta"), "beta")

    def test_nested_root_longest_wins(self):
        self.assertEqual(vi.resolve_project_name(self.base / "nest" / "sub"), "inner")
        self.assertEqual(vi.resolve_project_name(self.base / "nest"), "outer")

    def test_git_marker_basename(self):
        repo = self.base / "lonely" / "myrepo"
        (repo / ".git").mkdir(parents=True)
        self.assertEqual(vi.resolve_project_name(repo), "myrepo")

    def test_vindex_marker_names_project(self):
        d = self.base / "lonely" / "named"
        d.mkdir(parents=True)
        (d / ".vindex").write_text("custom-name\n")
        self.assertEqual(vi.resolve_project_name(d), "custom-name")

    def test_falls_back_to_default(self):
        # a dir under no configured root and (within the temp tree) no marker
        self.assertEqual(vi.resolve_project_name(self.base / "lonely"), "default")


if __name__ == "__main__":
    unittest.main(verbosity=2)
