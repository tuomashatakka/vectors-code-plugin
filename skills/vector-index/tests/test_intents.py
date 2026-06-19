#!/usr/bin/env python3
"""
Model-free unit tests for the intent-memory feature (scripts/intents.py).

These exercise the whole feature WITHOUT loading an embedding model: intent
canonicalization, the SQLite store, the lexical (BM25 + token-overlap) recall
fast-path, project-scoped-with-global-fallback ordering, transcript grading, the
injection renderer, and the reserved-store filtering in vector_index. They run in
milliseconds and never touch the network.

Run:
    ./.venv/bin/python -m unittest tests.test_intents -v
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import intents  # noqa: E402  (bare-Python importable; no model stack)
import transcript as tx  # noqa: E402

try:  # vector_index needs the model stack (zvec + sentence-transformers)
    import vector_index as vi  # noqa: E402
    HAVE_VI = True
except Exception:
    vi = None
    HAVE_VI = False


class IntentTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="vindex-intent-test-")
        self._old_home = os.environ.get("VINDEX_HOME")
        os.environ["VINDEX_HOME"] = self._tmp
        # neutralize the Ollama judge so grading uses the deterministic heuristic
        os.environ["VINDEX_INTENT_NO_JUDGE"] = "1"

    def tearDown(self):
        if self._old_home is not None:
            os.environ["VINDEX_HOME"] = self._old_home
        else:
            os.environ.pop("VINDEX_HOME", None)
        os.environ.pop("VINDEX_INTENT_NO_JUDGE", None)
        shutil.rmtree(self._tmp, ignore_errors=True)

    def store(self):
        return intents.IntentStore.open()


class NormalizeTests(IntentTest):
    def test_strips_filler_and_fences(self):
        a = intents.normalize_intent("Hey, could you please reset the dev database?")
        b = intents.normalize_intent("reset dev database")
        self.assertEqual(a, b)
        self.assertNotIn("please", a)
        self.assertNotIn("the", a.split())

    def test_drops_code_fences(self):
        n = intents.normalize_intent("fix this ```python\nprint(1)\n``` error")
        self.assertNotIn("print", n)
        self.assertIn("fix", n.split())

    def test_intent_id_dedupes_equivalent_phrasings(self):
        i1 = intents.intent_id(intents.normalize_intent("Please reset the dev DB"))
        i2 = intents.intent_id(intents.normalize_intent("reset dev db"))
        self.assertEqual(i1, i2)
        self.assertEqual(len(i1), 31)
        self.assertTrue(i1.startswith("i"))


class StoreTests(IntentTest):
    def test_record_increments_frequency(self):
        s = self.store()
        s.record("how do I reset the dev database", project="alpha", session="s1")
        s.record("reset dev database", project="alpha", session="s2")
        rows = s.stats(project="alpha")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["frequency"], 2)
        s.close()

    def test_recall_fastpath_no_model(self):
        s = self.store()
        s.record("how do I reset the dev database", project="alpha", session="s1",
                 response="run scripts/db_reset.sh --env=dev")
        # second occurrence + recall, lexical only (allow_embed=False) — must not
        # import sentence-transformers.
        res = s.recall("reset the dev database", project="alpha", allow_embed=False)
        self.assertTrue(res["matches"])
        self.assertEqual(res["matches"][0]["frequency"], 1)
        self.assertIn("intent-memory", res["injection"])
        # the fast path must never instantiate an embedding model
        if HAVE_VI:
            self.assertEqual(vi._EMBEDDERS, {})
        s.close()

    def test_project_scope_with_global_fallback(self):
        s = self.store()
        s.record("deploy app to staging", project="alpha", session="s1")
        s.record("deploy app to production", project="beta", session="s2")
        # from alpha: the alpha intent is preferred (ranked first)
        res = s.recall("deploy app", project="alpha", allow_embed=False, topk=2)
        self.assertTrue(res["matches"])
        self.assertEqual(res["matches"][0]["project"], "alpha")
        # from a project with no local match: global fallback still finds beta's
        res2 = s.recall("deploy app", project="gamma", allow_embed=False, topk=2)
        self.assertTrue(res2["matches"])
        projects = {m["project"] for m in res2["matches"]}
        self.assertTrue(projects & {"alpha", "beta"})
        s.close()

    def test_resolution_cap(self):
        s = self.store()
        for i in range(20):
            s.record("recurring intent here", project="alpha", session=f"s{i}",
                     response=f"answer number {i}")
        rows = s._resolutions(intents.intent_id(intents.normalize_intent(
            "recurring intent here")))
        self.assertLessEqual(len(rows), intents._RESOLUTION_CAP)
        s.close()

    def test_explicit_grade(self):
        s = self.store()
        s.record("set up ci pipeline", project="alpha", session="s1",
                 response="add .github/workflows/ci.yml")
        iid = intents.intent_id(intents.normalize_intent("set up ci pipeline"))
        s.grade(iid, outcome="resolved", score=1.0, grader="explicit")
        res = s.recall("set up ci pipeline", project="alpha", allow_embed=False)
        self.assertIn("worked", res["injection"])
        s.close()


class HeuristicGradeTests(IntentTest):
    def test_reask_is_unresolved(self):
        g = intents.heuristic_grade("reset the dev database",
                                    "that didn't work, reset the dev database again")
        self.assertEqual(g["outcome"], "unresolved")

    def test_acceptance_is_resolved(self):
        g = intents.heuristic_grade("reset the dev database",
                                    "thanks, that worked perfectly")
        self.assertEqual(g["outcome"], "resolved")

    def test_topic_change_is_resolved(self):
        g = intents.heuristic_grade("reset the dev database",
                                    "now add a new column to the users table")
        self.assertEqual(g["outcome"], "resolved")


class GradePendingTests(IntentTest):
    def _write_transcript(self, msgs):
        path = Path(self._tmp) / "transcript.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            for role, text in msgs:
                fh.write(json.dumps({"type": role,
                                     "message": {"role": role, "content": text}}) + "\n")
        return str(path)

    def test_grade_pending_finalizes_prior_turn(self):
        s = self.store()
        s.record("reset the dev database", project="alpha", session="s1")
        # transcript: user asked, assistant answered, user re-asked (=> unresolved)
        path = self._write_transcript([
            ("user", "reset the dev database"),
            ("assistant", "run db_reset.sh"),
            ("user", "that still doesn't work, reset the dev database"),
            ("assistant", "try dropping the schema first"),
        ])
        out = s.grade_pending(path, project="alpha", session="s1")
        graded = {g["intent_id"]: g for g in out["graded"]}
        iid = intents.intent_id(intents.normalize_intent("reset the dev database"))
        self.assertIn(iid, graded)
        self.assertEqual(graded[iid]["outcome"], "unresolved")
        s.close()

    def test_transcript_parsing_roundtrip(self):
        path = self._write_transcript([("user", "hello"), ("assistant", "hi there")])
        msgs = tx.parse_transcript(path)
        self.assertEqual(msgs, [("user", "hello"), ("assistant", "hi there")])
        self.assertEqual(tx.last_exchanges(path, 1), [("assistant", "hi there")])


class InjectionTests(IntentTest):
    def test_empty_when_no_matches(self):
        self.assertEqual(intents.render_injection([]), "")

    def test_respects_token_budget(self):
        match = [{
            "intent_id": "i" + "0" * 30, "intent_text": "x", "project": "alpha",
            "frequency": 3,
            "resolutions": [
                {"response_excerpt": "do the thing " * 50, "outcome": "resolved",
                 "score": 0.9, "grader": "llm"},
                {"response_excerpt": "the bad way " * 50, "outcome": "unresolved",
                 "score": 0.1, "grader": "llm"},
            ],
        }]
        full = intents.render_injection(match, max_tokens=1000)
        tiny = intents.render_injection(match, max_tokens=5)
        self.assertIn("3 time(s)", full)
        self.assertLess(len(tiny), len(full))
        self.assertIn("intent-memory", tiny)  # header always survives


class LightProjectTests(IntentTest):
    def test_env_pin_wins(self):
        os.environ["VINDEX_PROJECT"] = "pinned"
        try:
            self.assertEqual(intents.light_project("/tmp"), "pinned")
        finally:
            os.environ.pop("VINDEX_PROJECT", None)

    def test_marker_walk_uses_dir_basename(self):
        repo = Path(self._tmp) / "myrepo"
        (repo / "sub").mkdir(parents=True)
        (repo / ".git").mkdir()
        os.environ.pop("VINDEX_PROJECT", None)
        self.assertEqual(intents.light_project(str(repo / "sub")), "myrepo")

    def test_vindex_file_overrides_basename(self):
        repo = Path(self._tmp) / "dir"
        repo.mkdir()
        (repo / ".vindex").write_text("custom-name\n")
        os.environ.pop("VINDEX_PROJECT", None)
        self.assertEqual(intents.light_project(str(repo)), "custom-name")

    def test_falls_back_to_default(self):
        os.environ.pop("VINDEX_PROJECT", None)
        empty = Path(self._tmp) / "nowhere"
        empty.mkdir()
        # a path with no marker resolves to the configured default
        self.assertEqual(intents.light_project(str(empty)),
                         os.environ.get("VINDEX_DEFAULT", "default"))


@unittest.skipUnless(HAVE_VI, "requires the model stack (vector_index import)")
class ReservedStoreTests(IntentTest):
    def test_intents_store_hidden_from_projects(self):
        s = self.store()
        s.record("anything at all here", project="alpha", session="s1")
        s.close()
        # the __intents__ dir exists under HOME but must not be listed as a project
        vi.HOME = Path(self._tmp)  # align the engine's cached HOME with our temp
        self.assertTrue((vi.HOME / intents.INTENTS_DIR_NAME).exists())
        self.assertNotIn(intents.INTENTS_DIR_NAME, vi.list_indexes())


if __name__ == "__main__":
    unittest.main()
