#!/usr/bin/env python3
"""
Unit tests for the capability modules (hybrid, grounding, orchestration,
references). These are stdlib-only — no embedding/zvec stack — so they run fast
and offline:

    python3 tests/test_enhancements.py
    python3 -m unittest discover -s tests -v
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import assemble  # noqa: E402
import grounding  # noqa: E402
import guards  # noqa: E402
import hybrid  # noqa: E402
import orchestration as orch  # noqa: E402
import prompts  # noqa: E402
import references as refs  # noqa: E402
import units  # noqa: E402


class TokenizeTest(unittest.TestCase):
    def test_keeps_reference_shapes_and_words(self):
        toks = hybrid.tokenize("See KPL 3:9.2 and statute 228/1929 about Indemnification")
        self.assertIn("228/1929", toks)
        self.assertIn("3:9.2", toks)
        self.assertIn("indemnification", toks)  # lowercased word


class BM25Test(unittest.TestCase):
    def setUp(self):
        self.items = [
            ("d1", "the flock loop picks ideas deterministically", {"text": "a"}),
            ("d2", "welded indexed geometry with a deterministic seed", {"text": "b"}),
            ("d3", "statute 228/1929 governs indemnification obligations", {"text": "c"}),
        ]
        self.ix = hybrid.BM25Index().build(self.items)

    def test_semantic_word_ranks_right_doc(self):
        hits = self.ix.search("geometry seed", topk=3)
        self.assertEqual(hits[0][0], "d2")

    def test_exact_reference_match(self):
        hits = self.ix.search("228/1929", topk=3)
        self.assertTrue(hits and hits[0][0] == "d3")

    def test_no_match_returns_empty(self):
        self.assertEqual(self.ix.search("zzz-nonexistent-token"), [])

    def test_save_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bm25.json.gz"
            self.ix.save(p)
            loaded = hybrid.BM25Index.load(p)
            self.assertEqual(loaded.N, 3)
            self.assertEqual(loaded.search("228/1929")[0][0], "d3")
            self.assertEqual(loaded.docs["d3"]["text"], "c")

    def test_load_missing_is_none(self):
        self.assertIsNone(hybrid.BM25Index.load("/nonexistent/bm25.json.gz"))


class RRFTest(unittest.TestCase):
    def test_fusion_rewards_agreement(self):
        dense = ["a", "b", "c"]
        lexical = ["b", "a", "d"]
        fused = dict(hybrid.rrf_fuse([dense, lexical]))
        # 'b' is rank0+rank1, 'a' is rank0+rank1 too -> both beat single-list 'c'/'d'
        self.assertGreater(fused["a"], fused["c"])
        self.assertGreater(fused["b"], fused["d"])

    def test_weighting_shifts_order(self):
        a_only = ["a"]
        b_only = ["b"]
        fused = dict(hybrid.rrf_fuse([a_only, b_only], weights=[3.0, 1.0]))
        self.assertGreater(fused["a"], fused["b"])


class ContextPrefixTest(unittest.TestCase):
    def test_prefixes_title_and_location(self):
        out = hybrid.context_prefix("Indemnification", "contracts/saas.md", "body text")
        self.assertTrue(out.startswith("Indemnification — contracts/saas.md"))
        self.assertIn("body text", out)

    def test_no_context_is_noop(self):
        self.assertEqual(hybrid.context_prefix(None, None, "body"), "body")


class ConfidenceTest(unittest.TestCase):
    def test_high_from_strong_rerank(self):
        r = [{"rerank_score": 6.0, "signals": ["dense"]}]
        self.assertEqual(grounding.confidence_tier(r, reranked=True), "high")

    def test_agreement_promotes_medium_to_high(self):
        r = [{"rerank_score": 1.0, "signals": ["dense", "lexical"]}]
        self.assertEqual(grounding.confidence_tier(r, reranked=True), "high")

    def test_low_when_negative_and_single_signal(self):
        r = [{"rerank_score": -3.0, "signals": ["dense"]}]
        self.assertEqual(grounding.confidence_tier(r, reranked=True), "low")

    def test_empty_is_low(self):
        self.assertEqual(grounding.confidence_tier([], reranked=True), "low")

    def test_cosine_thresholds_when_not_reranked(self):
        self.assertEqual(
            grounding.confidence_tier([{"vector_score": 0.6, "signals": ["dense"]}], reranked=False),
            "high",
        )


class VerifyClaimTest(unittest.TestCase):
    def test_supported_claim(self):
        out = grounding.verify_claim(
            "indemnification obligations apply",
            ["This statute governs indemnification obligations for parties."],
        )
        self.assertTrue(out["supported"])
        self.assertEqual(out["source_index"], 0)

    def test_unsupported_claim(self):
        out = grounding.verify_claim("quantum teleportation of cats", ["unrelated legal text"])
        self.assertFalse(out["supported"])
        self.assertEqual(out["source_index"], -1)


class OrchestrationTest(unittest.TestCase):
    def test_intent_classification(self):
        self.assertEqual(orch.classify_query_intent("what are OUR payment terms"), "scoped")
        self.assertEqual(orch.classify_query_intent("what does the standard require"), "shared")
        self.assertEqual(orch.classify_query_intent("payment terms"), "balanced")

    def test_project_weights_bridge(self):
        w = orch.project_weights(["law", "acme"], shared=["law"], intent="scoped")
        self.assertGreater(w["acme"], w["law"])  # scoped intent favors the scoped project

    def test_project_weights_equal_without_shared(self):
        w = orch.project_weights(["a", "b"], shared=None, intent="balanced")
        self.assertEqual(w["a"], w["b"])

    def test_layer_of(self):
        self.assertEqual(orch.layer_of("law", ["law"]), "shared")
        self.assertEqual(orch.layer_of("acme", ["law"]), "scoped")


class ReferencesTest(unittest.TestCase):
    def test_extract_urls_and_citations(self):
        out = refs.extract_references("see https://x.io/a and statute 228/1929 and RFC 7231")
        uris = {r["uri"] for r in out}
        self.assertIn("https://x.io/a", uris)
        self.assertIn("228/1929", uris)
        self.assertTrue(any("7231" in u for u in uris))

    def test_dedupe(self):
        out = refs.extract_references("228/1929 and again 228/1929")
        self.assertEqual(sum(1 for r in out if r["uri"] == "228/1929"), 1)

    def test_validate_flags_unverified(self):
        # fake corpus: only "228/1929" appears verbatim in a chunk
        def fake_search(q, k):
            if "228/1929" in q:
                return {"results": [{"text": "statute 228/1929 text", "source": "law.md"}]}
            return {"results": []}

        out = refs.validate_citations("cite 228/1929 and bogus 999/2999", fake_search)
        verdicts = {v["uri"]: v["verified"] for v in out["references"]}
        self.assertTrue(verdicts["228/1929"])
        self.assertFalse(verdicts["999/2999"])
        self.assertIn("999/2999 [UNVERIFIED]", out["annotated"])
        self.assertNotIn("228/1929 [UNVERIFIED]", out["annotated"])

    def test_resolve_reference_no_network_is_unchecked(self):
        out = refs.resolve_reference("https://example.com", network=False)
        self.assertFalse(out["checked"])


class UnitsTest(unittest.TestCase):
    def test_markdown_section_vs_text(self):
        self.assertEqual(units.classify_unit("a.md", "# Heading\nbody"), "section")
        self.assertEqual(units.classify_unit("a.md", "just prose, no heading"), "text")

    def test_code_symbol_and_definition(self):
        self.assertEqual(units.classify_unit("a.py", "def run(x):\n    return x"), "symbol")
        self.assertEqual(units.classify_unit("a.ts", "export class Foo {}"), "symbol")
        self.assertEqual(units.classify_unit("a.ts", "interface Opts { n: number }"), "definition")
        self.assertEqual(units.classify_unit("a.py", "x = 1\nprint(x)"), "code")

    def test_symbol_name(self):
        self.assertEqual(units.symbol_name("def run_flock(ideas):"), "run_flock")
        self.assertEqual(units.symbol_name("export function useThing() {}"), "useThing")
        self.assertIsNone(units.symbol_name("just some prose"))


class AssembleTest(unittest.TestCase):
    def test_trims_to_budget_and_counts(self):
        # 6 words -> round(6/0.75)=8 tokens each; budget 20 fits exactly two.
        results = [{"text": "alpha beta gamma delta epsilon zeta"},
                   {"text": "one two three four five six"},
                   {"text": "uno dos tres cuatro cinco seis"}]
        kept, total = assemble.assemble_within_budget(results, max_tokens=20)
        self.assertEqual(len(kept), 2)
        self.assertLessEqual(total, 20)
        self.assertEqual(kept[0]["token_count"], 8)

    def test_dedup_identical_content(self):
        results = [{"text": "same body"}, {"text": "same   body"}]  # whitespace-normalized dup
        kept, _ = assemble.assemble_within_budget(results, max_tokens=0)
        self.assertEqual(len(kept), 1)

    def test_first_item_always_included(self):
        kept, _ = assemble.assemble_within_budget([{"text": "w " * 100}], max_tokens=1)
        self.assertEqual(len(kept), 1)


class GuardsTest(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_readonly_blocks_mutation(self):
        os.environ["VINDEX_READONLY"] = "1"
        self.assertIsNotNone(guards.deny_if_readonly("ingest"))
        os.environ["VINDEX_READONLY"] = "0"
        self.assertIsNone(guards.deny_if_readonly("ingest"))

    def test_allow_roots(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["VINDEX_ALLOW_ROOTS"] = d
            self.assertTrue(guards.path_allowed(str(Path(d) / "sub" / "f.txt")))
            self.assertFalse(guards.path_allowed("/etc/passwd"))

    def test_no_allowlist_is_unrestricted(self):
        os.environ.pop("VINDEX_ALLOW_ROOTS", None)
        self.assertTrue(guards.path_allowed("/anywhere"))


class PromptsTest(unittest.TestCase):
    def test_grounded_answer_includes_rules_and_question(self):
        out = prompts.grounded_answer("What is X?", "context body")
        self.assertIn("ONLY", out)
        self.assertIn("What is X?", out)
        self.assertIn("[UNVERIFIED]", out)

    def test_render_unknown_raises(self):
        with self.assertRaises(KeyError):
            prompts.render("nope")

    def test_decompose_and_citation(self):
        self.assertIn("sub-question", prompts.decompose("ship the feature"))
        self.assertIn("citation", prompts.citation_contract().lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
