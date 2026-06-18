#!/usr/bin/env python3
"""
Unit tests for the capability modules (hybrid, grounding, orchestration,
references). These are stdlib-only — no embedding/zvec stack — so they run fast
and offline:

    python3 tests/test_enhancements.py
    python3 -m unittest discover -s tests -v
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import grounding  # noqa: E402
import hybrid  # noqa: E402
import orchestration as orch  # noqa: E402
import references as refs  # noqa: E402


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
