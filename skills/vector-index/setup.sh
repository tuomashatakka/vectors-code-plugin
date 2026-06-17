#!/usr/bin/env bash
# One-command setup for the vector-index skill (global project-partitioned RAG).
#   bash setup.sh                       # create .venv and install deps
#   bash setup.sh <project> <dir>       # ...then create a project over <dir> and ingest
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if command -v uv >/dev/null 2>&1; then
  uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
else
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi
echo "env ready: $(pwd)/.venv"

if [ "${1:-}" != "" ] && [ "${2:-}" != "" ]; then
  ./.venv/bin/python scripts/vindex.py create "$1" --root "$2" --source "$2"
  ./.venv/bin/python scripts/vindex.py ingest "$1"
  echo "project '$1' built. try:  ./.venv/bin/python scripts/vindex.py query \"...\""
fi
