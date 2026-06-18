#!/usr/bin/env python3
"""
UserPromptSubmit hook — recall prior resolutions for the incoming intent.

Claude Code (and compatible harnesses) invoke this with the hook payload on stdin
(session_id, transcript_path, cwd, prompt). It:

  1. Does a FAST, model-free recall (SQLite exact match + BM25) of intents similar
     to the prompt, scoped to the cwd's project with a global fallback, and prints
     a compact knowledge block to stdout — which the harness adds to the context
     BEFORE the assistant replies.
  2. Fires a DETACHED writer (`vindex intent record --async`) to embed and store
     the new intent, so the slow model load never blocks the prompt.

It must never break a turn: it honours VINDEX_INTENT_DISABLE, has a hard wall-
clock budget, and always exits 0 — any error is swallowed silently.
"""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

_TRUE = {"1", "true", "yes", "on"}


def _disabled() -> bool:
    return os.environ.get("VINDEX_INTENT_DISABLE", "").strip().lower() in _TRUE


def _read_payload() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except Exception:
        return {}


def _recall(prompt: str, cwd: str) -> str:
    # Stdlib-only path: `intents` does NOT import the model stack, and
    # light_project resolves the project without it either — so recall stays fast.
    import intents
    project = intents.light_project(cwd or None)
    store = intents.IntentStore.open()
    try:
        allow_embed = os.environ.get("VINDEX_INTENT_SYNC_EMBED", "").strip().lower() in _TRUE
        res = store.recall(prompt, project=project, allow_embed=allow_embed)
        return res.get("injection", "")
    finally:
        store.close()


def _fire_writer(prompt: str, cwd: str, session: str) -> None:
    """Detached: record + embed the new intent without blocking the hook. The
    child resolves the project itself (full resolver) from its cwd."""
    py = sys.executable
    cmd = [py, str(SCRIPTS / "vindex.py"), "intent", "record", "--async"]
    if session:
        cmd += ["--session", session]
    cmd += ["--", prompt]  # `--` so a prompt starting with '-' isn't read as a flag
    try:
        subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, cwd=cwd or None)
    except Exception:
        pass


def main() -> int:
    if _disabled():
        return 0
    payload = _read_payload()
    prompt = (payload.get("prompt") or "").strip()
    cwd = payload.get("cwd") or os.getcwd()
    session = payload.get("session_id") or ""
    if not prompt:
        return 0

    # Recall under a hard time budget so a cold sidecar load can never hang a turn.
    box: dict[str, str] = {}

    def work():
        try:
            box["out"] = _recall(prompt, cwd)
        except Exception:
            box["out"] = ""

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout=float(os.environ.get("VINDEX_INTENT_TIMEOUT", "1.5")))
    injection = box.get("out", "")
    if injection:
        print(injection)

    # Always kick off the async writer (its own process, survives hook exit).
    try:
        _fire_writer(prompt, cwd, session)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
