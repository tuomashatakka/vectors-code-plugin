#!/usr/bin/env python3
"""
Stop hook — grade the just-finished exchange.

Invoked when the assistant finishes a turn (payload on stdin: session_id,
transcript_path, cwd). It attaches the assistant's response to the pending
resolution for the answered intent and grades it — using a LOCAL Ollama judge
when reachable (or forced), otherwise a transcript heuristic that also finalizes
the previous turn's intent now that its follow-up message is visible.

Like the recall hook, it must never break a turn: honours VINDEX_INTENT_DISABLE
and always exits 0.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

_TRUE = {"1", "true", "yes", "on"}


def _disabled() -> bool:
    return os.environ.get("VINDEX_INTENT_DISABLE", "").strip().lower() in _TRUE


def main() -> int:
    if _disabled():
        return 0
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return 0
    transcript_path = payload.get("transcript_path")
    if not transcript_path or not os.path.exists(transcript_path):
        return 0
    cwd = payload.get("cwd") or os.getcwd()
    session = payload.get("session_id") or ""

    # Grade in a detached child: the Ollama judge may take seconds, and the Stop
    # hook must never hold up the turn. The child resolves the project from cwd.
    cmd = [sys.executable, str(SCRIPTS / "vindex.py"), "intent", "grade",
           "--transcript", transcript_path]
    if session:
        cmd += ["--session", session]
    try:
        subprocess.Popen(
            cmd, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, cwd=cwd or None)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
