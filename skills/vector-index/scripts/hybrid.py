#!/usr/bin/env python3
"""
hybrid — lexical (BM25) retrieval + rank fusion, the sparse half of hybrid search.

The engine is dense-only today: query → embed → vector top-k → cross-encoder
rerank. That misses *exact* tokens — identifiers, error codes, citations like
"228/1929" or "KPL 3:9.2" — which a keyword index nails. This module adds a
compact, persistable BM25 index plus Reciprocal Rank Fusion so `vector_index` can
retrieve from the dense and sparse legs in parallel, fuse the two rankings, and
rerank the union. (C3 in references/generalized-capabilities.md.)

Stdlib only — no embedding stack — so it builds, persists, and unit-tests on its
own. The BM25 file also stores each doc's render fields, so a lexical-only hit
(missed by the dense leg) can be returned without a vector-store point lookup.
"""

from __future__ import annotations

import gzip
import json
import math
import re
from pathlib import Path

# Tokenizer: keep reference-shaped tokens whole ("228/1929", "3:9.2", "2024-123")
# and otherwise split on unicode word chars (covers identifiers and prose, any
# language). Lemmatization is a deliberate future hook, not done here.
_TOKEN_RE = re.compile(r"[0-9]+(?:[/:.\-][0-9]+)+|\w+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


def context_prefix(title: str | None, location: str | None, text: str) -> str:
    """Prepend a chunk's hierarchical context (title — location) to its text.

    Embedding/indexing the context-enriched text reduces Document-Level Retrieval
    Mismatch in boilerplate-heavy corpora (C2); the raw text is what gets stored
    for display. A no-op when there's no context to add.
    """
    head = " — ".join(p for p in (title, location) if p)
    return f"{head}\n\n{text}" if head else text


class BM25Index:
    """Okapi BM25 over a set of documents, with a co-stored render field map."""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.doc_ids: list[str] = []
        self.docs: dict[str, dict] = {}      # doc_id -> render fields
        self._tf: list[dict[str, int]] = []  # aligned with doc_ids
        self._len: list[int] = []
        self._df: dict[str, int] = {}
        self.avgdl: float = 0.0
        self.N: int = 0

    # -- build --------------------------------------------------------------
    def build(self, items: list[tuple[str, str, dict]]) -> "BM25Index":
        """items: (doc_id, indexable_text, render_fields)."""
        self.__init__(self.k1, self.b)
        for doc_id, text, fields in items:
            toks = tokenize(text)
            tf: dict[str, int] = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            self.doc_ids.append(doc_id)
            self.docs[doc_id] = fields
            self._tf.append(tf)
            self._len.append(len(toks))
            for t in tf:
                self._df[t] = self._df.get(t, 0) + 1
        self.N = len(self.doc_ids)
        self.avgdl = (sum(self._len) / self.N) if self.N else 0.0
        return self

    # -- query --------------------------------------------------------------
    def _idf(self, term: str) -> float:
        df = self._df.get(term, 0)
        # BM25+ idf: strictly positive, avoids negative weights on common terms.
        return math.log(1 + (self.N - df + 0.5) / (df + 0.5))

    def search(self, query: str, topk: int = 24) -> list[tuple[str, float]]:
        if not self.N:
            return []
        q_terms = set(tokenize(query))
        if not q_terms:
            return []
        idf = {t: self._idf(t) for t in q_terms}
        scored: list[tuple[str, float]] = []
        for i, tf in enumerate(self._tf):
            dl = self._len[i] or 1
            s = 0.0
            for t in q_terms:
                f = tf.get(t)
                if not f:
                    continue
                denom = f + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1))
                s += idf[t] * (f * (self.k1 + 1)) / denom
            if s > 0:
                scored.append((self.doc_ids[i], s))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:topk]

    # -- persistence --------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "k1": self.k1, "b": self.b, "avgdl": self.avgdl, "N": self.N,
            "doc_ids": self.doc_ids, "len": self._len, "df": self._df,
            "tf": self._tf, "docs": self.docs,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "BM25Index":
        ix = cls(d.get("k1", 1.5), d.get("b", 0.75))
        ix.doc_ids = d["doc_ids"]; ix.docs = d["docs"]
        ix._tf = d["tf"]; ix._len = d["len"]; ix._df = d["df"]
        ix.avgdl = d["avgdl"]; ix.N = d["N"]
        return ix

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh)

    @classmethod
    def load(cls, path: str | Path) -> "BM25Index | None":
        path = Path(path)
        if not path.exists():
            return None
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))


def rrf_fuse(
    rankings: list[list[str]],
    weights: list[float] | None = None,
    k: int = 60,
) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion of several ranked id-lists (best first).

    score(d) = Σ_r weight_r / (k + rank_r(d)). Rank-based, so it fuses scores from
    incomparable scales (cosine vs BM25 vs cross-project) without normalization —
    exactly why both source documents reach for it.
    """
    weights = weights or [1.0] * len(rankings)
    scores: dict[str, float] = {}
    for ranking, w in zip(rankings, weights):
        for rank, did in enumerate(ranking):
            scores[did] = scores.get(did, 0.0) + w / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
