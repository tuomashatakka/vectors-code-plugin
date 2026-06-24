#!/usr/bin/env bash
# One-command setup for the vector-index plugin (TypeScript on Bun, Postgres+pgvector).
#   bash setup.sh                    install deps, apply schema, prompt to install the daemon
#   bash setup.sh -y, --yes          non-interactive: assume "yes" (install the daemon too)
#   bash setup.sh -n, --no-daemon    install deps + schema only, skip the daemon
#   bash setup.sh <project> <dir>    also create a project over <dir> and ingest it
#   bash setup.sh -h, --help         show this help
set -euo pipefail

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; }

ASSUME_YES=0; NO_DAEMON=0; POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    -n|--no-daemon) NO_DAEMON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [ $# -gt 0 ]; do POSITIONAL+=("$1"); shift; done ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

# The TypeScript lives at the repo root; this script sits in skills/vector-index.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

command -v bun >/dev/null 2>&1 || { echo "!! bun is required — install it: https://bun.sh" >&2; exit 1; }

echo ">> installing dependencies (bun install)"
bun install

# --- Postgres + pgvector ----------------------------------------------------
DSN="${VINDEX_DSN:-${UKDB_DSN:-}}"
if [ -z "$DSN" ]; then
  cat <<MSG

>> No VINDEX_DSN/UKDB_DSN set — using the default postgres://localhost:5432/vectors
   (a local Postgres + pgvector, e.g.  brew install postgresql@16 pgvector ).
   Override by exporting VINDEX_DSN. No local Postgres? Spin up a throwaway one:
     docker run -d --name vectors-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vectors \\
       -p 5432:5432 pgvector/pgvector:pg16
     export VINDEX_DSN=postgres://postgres:x@localhost:5432/vectors
MSG
fi
echo ">> applying schema (${DSN:-postgres://localhost:5432/vectors})"
bun src/db/schema.ts

# --- optional project build -------------------------------------------------
if [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ -n "$DSN" ]; then
  bun src/cli.ts create "$1" --root "$2"
  bun src/cli.ts add-source "$1" --id docs --path "$2" --glob '**/*'
  bun src/cli.ts ingest "$1"
  echo "project '$1' built. try:  bun src/cli.ts query \"...\" --project $1"
fi

# --- optional background daemon ---------------------------------------------
if [ "$NO_DAEMON" -eq 0 ]; then
  if [ "$ASSUME_YES" -eq 1 ]; then reply=y
  else read -r -p "Install the background sync daemon? (needs Postgres) [y/N] " reply || reply=""; fi
  case "${reply:-n}" in
    [yY]*) bash "$HERE/daemon/install.sh" || echo "!! daemon not installed — set UKDB_DSN, then: bash $HERE/daemon/install.sh" ;;
    *) echo "skipped the daemon. install later: bash $HERE/daemon/install.sh" ;;
  esac
fi
