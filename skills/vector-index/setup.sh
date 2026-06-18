#!/usr/bin/env bash
# One-command setup for the vector-index skill (global project-partitioned RAG).
#   bash setup.sh                       # create .venv, install deps, prompt to install the daemon
#   bash setup.sh -y                    # ...non-interactive: assume "yes" (install the daemon too)
#   bash setup.sh <project> <dir>       # ...then create a project over <dir> and ingest
#   bash setup.sh -y <project> <dir>    # flags and positionals can be combined
set -euo pipefail

usage() {
  cat <<'USAGE'
setup.sh — one-command setup for the vector-index skill.
  bash setup.sh                    create .venv, install deps, prompt to install the daemon
  bash setup.sh -y, --yes          non-interactive: assume "yes" (install the daemon too)
  bash setup.sh <project> <dir>    also create a project over <dir> and ingest it
  bash setup.sh -h, --help         show this help
USAGE
}

# --- flags ------------------------------------------------------------------
# -y/--yes assumes "yes" to the daemon prompt (for programmatic / CI use).
ASSUME_YES=0
POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
# Create the venv only if missing (idempotent re-runs); always (re)install deps.
if command -v uv >/dev/null 2>&1; then
  [ -d .venv ] || uv venv .venv
  uv pip install --python .venv/bin/python -r requirements.txt
else
  [ -d .venv ] || "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi
echo "env ready: $(pwd)/.venv"

# --- optional background daemon (Claude-history + source sync) ---------------
# The daemon syncs ~/.claude/projects/**/*.jsonl and your sources into a
# Postgres+pgvector store. It needs daemon/ukdb-daemon.env (UKDB_DSN) configured
# first; daemon/install.sh fails fast with guidance if it isn't.
if [ "$ASSUME_YES" -eq 1 ]; then
  reply=y
else
  read -r -p "Install the background daemon (Claude-history + source sync)? [Y/n] " reply || reply=""
fi
case "${reply:-y}" in
  [nN]*) echo "skipping daemon. install later with:  bash daemon/install.sh" ;;
  *) bash daemon/install.sh || echo "!! daemon not installed (see above). configure daemon/ukdb-daemon.env (UKDB_DSN) then rerun:  bash daemon/install.sh" ;;
esac

if [ "${1:-}" != "" ] && [ "${2:-}" != "" ]; then
  ./.venv/bin/python scripts/vindex.py create "$1" --root "$2" --source "$2"
  ./.venv/bin/python scripts/vindex.py ingest "$1"
  echo "project '$1' built. try:  ./.venv/bin/python scripts/vindex.py query \"...\""
fi
