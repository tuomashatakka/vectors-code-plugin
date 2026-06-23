#!/usr/bin/env bash
# Digest every immediate child directory of a parent (default ~/Documents/Projects)
# into the local vector-index store. Idempotent: skips projects that already have
# data, rebuilds empty ones, creates+ingests new ones. Giant model/container repos
# are skipped (logged, never silently). The background daemon mirrors the result
# into Postgres on its next sweep.
#
#   bash digest_projects.sh [PARENT_DIR]
#   DRY_RUN=1 bash digest_projects.sh      # print decisions, change nothing
set -uo pipefail

PARENT="${1:-$HOME/Documents/Projects}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$HERE/../.venv/bin/python"; [ -x "$PY" ] || PY="$(command -v python3)"
VINDEX="$HERE/vindex.py"
STORE="${VINDEX_HOME:-$HOME/.local/share/vector-index}"
DRY="${DRY_RUN:-0}"

# Giant model/container repos: embeddings add little, cost lots. Skip + log.
EXCLUDE=" ai BigVGAN-2.4 whisper-vits-svc meshes "

norm(){ printf '%s' "$1" | tr 'A-Z' 'a-z' | tr ' .' '--'; }  # space & dot -> dash (zvec collection names reject dots)
run(){ if [ "$DRY" = 1 ]; then echo "    DRY: $*"; else "$@"; fi; }

created=0 rebuilt=0 skipped_data=0 skipped_excl=0 failed=0
for dir in "$PARENT"/*/; do
  base="$(basename "$dir")"
  case "$EXCLUDE" in *" $base "*) echo ">> SKIP (excluded, giant/container): $base"; skipped_excl=$((skipped_excl+1)); continue;; esac
  name="$(norm "$base")"
  pd="$STORE/$name"
  if [ -d "$pd" ]; then
    kb=$(du -sk "$pd" 2>/dev/null | cut -f1); kb=${kb:-0}
    if [ "$kb" -gt 1024 ]; then
      echo ">> SKIP (already ingested, ${kb}KB): $name"; skipped_data=$((skipped_data+1)); continue
    fi
    echo ">> REBUILD (empty, ${kb}KB): $name"
    if run "$PY" "$VINDEX" ingest "$name" --rebuild; then rebuilt=$((rebuilt+1)); else echo "   !! rebuild failed: $name"; failed=$((failed+1)); fi
  else
    echo ">> CREATE + INGEST: $name  <-  $dir"
    if run "$PY" "$VINDEX" create "$name" --root "$dir" --source "$dir" --strategy auto \
       && run "$PY" "$VINDEX" ingest "$name"; then created=$((created+1)); else echo "   !! create/ingest failed: $name"; failed=$((failed+1)); fi
  fi
done
echo
echo "== digest summary =="
echo "  created:        $created"
echo "  rebuilt:        $rebuilt"
echo "  skipped (data): $skipped_data"
echo "  skipped (excl): $skipped_excl"
echo "  failed:         $failed"
