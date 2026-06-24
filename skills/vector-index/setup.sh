#!/usr/bin/env bash
# Thin wrapper — the real setup lives in `vectors setup` (src/cli/index.ts):
# installs deps, applies the schema + migrations against the resolved DSN, and
# (with flags) links the global `vectors` bin and installs the daemon.
# Editor/MCP wiring is separate: `bash install.sh`.
#
#   bash setup.sh [--link] [--daemon] [--no-deps]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
command -v bun >/dev/null 2>&1 || { echo "!! bun is required — install it: https://bun.sh" >&2; exit 1; }
exec bun "$ROOT/src/cli/index.ts" setup "$@"
