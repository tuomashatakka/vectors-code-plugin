#!/usr/bin/env python3
"""
assemble — token-budgeted context assembly (C7).

Both source documents end retrieval the same way: merge the ranked results, then
trim to a token budget before handing context to a model. This module is that
final step — greedily keep the highest-ranked results whose running token total
fits the budget, deduplicating by normalized content so a chunk and an identical
message aren't both spent.

Stdlib only. The token estimate is a fast heuristic (no tokenizer dependency);
callers that need exact counts can pass their own via `counter`.
"""

from __future__ import annotations

from typing import Callable


def approx_tokens(text: str) -> int:
    """~0.75 words per token — close enough for budgeting, zero dependencies."""
    words = len((text or "").split())
    return max(1, round(words / 0.75)) if words else 0


def assemble_within_budget(
    results: list[dict],
    max_tokens: int,
    *,
    key: str = "text",
    counter: Callable[[str], int] = approx_tokens,
) -> tuple[list[dict], int]:
    """Keep results in order until `max_tokens` is reached; dedupe by content.

    Each kept result gains a `token_count`. The single best result is always
    included even if it alone exceeds the budget (better some context than none).
    `max_tokens <= 0` means "no limit" — just annotate and dedupe.
    """
    out: list[dict] = []
    total = 0
    seen: set[int] = set()
    for r in results:
        text = r.get(key) or ""
        sig = hash(" ".join(text.split()))
        if sig in seen:
            continue
        n = counter(text)
        if max_tokens and out and total + n > max_tokens:
            break
        seen.add(sig)
        item = dict(r)
        item["token_count"] = n
        out.append(item)
        total += n
    return out, total
