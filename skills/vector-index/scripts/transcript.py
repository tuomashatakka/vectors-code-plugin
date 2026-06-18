#!/usr/bin/env python3
"""
transcript — tolerant parsing of chat-transcript JSONL (Claude Code / Desktop).

A single source of truth for turning a harness transcript file into a flat list
of `(role, text)` message pairs. Both the background daemon (which mirrors chats
into Postgres) and the intent-memory grader (which reads the trailing exchange to
judge whether a response resolved an intent) need exactly this, so the logic
lives here rather than being duplicated.

Stdlib only — no model stack, no database — so it imports cheaply inside a hook.
"""

from __future__ import annotations

import json


def extract_text(content) -> str:
    """Tolerant: transcript `content` may be a string, a list of typed parts, or
    a dict. Tool-result parts nest their own list of blocks, so recurse instead of
    assuming each part flattens to a string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict):
                val = part.get("text")
                if val is None:
                    val = part.get("content")
                out.append(val if isinstance(val, str) else extract_text(val))
            else:
                out.append(str(part))
        return "\n".join(t for t in out if t)
    if isinstance(content, dict):
        val = content.get("text")
        if val is None:
            val = content.get("content")
        return val if isinstance(val, str) else extract_text(val)
    return ""


def parse_transcript(path: str) -> list[tuple[str, str]]:
    """Return [(role, text)] for message-bearing lines, skipping tool/meta events.

    NUL bytes are stripped so transcripts that embed binary/escape noise still
    parse (and remain safe to store in a text column) instead of erroring."""
    msgs: list[tuple[str, str]] = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                m = ev.get("message") if isinstance(ev, dict) else None
                role = (m or {}).get("role") or (ev.get("type") if isinstance(ev, dict) else None)
                if role not in ("user", "assistant", "tool"):
                    continue
                text = extract_text((m or {}).get("content") if m else ev.get("content"))
                if "\x00" in text:
                    text = text.replace("\x00", "")
                if text.strip():
                    msgs.append((role, text))
    except FileNotFoundError:
        pass
    return msgs


def last_exchanges(path: str, n: int = 8) -> list[tuple[str, str]]:
    """The trailing `n` message-bearing `(role, text)` pairs from a transcript."""
    msgs = parse_transcript(path)
    return msgs[-n:] if n and len(msgs) > n else msgs
