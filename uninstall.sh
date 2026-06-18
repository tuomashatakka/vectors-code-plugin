#!/usr/bin/env bash
# Reverse install.sh: drop the "vectors" MCP entry + skill symlink from each tool.
# Leaves the on-disk store ($VINDEX_HOME) and the daemon DB intact by design.
#
#   bash uninstall.sh            unlink skill + remove MCP entries from every tool
#   bash uninstall.sh --venv     ...and also delete the skill venv
#   bash uninstall.sh --daemon   ...and also run the daemon uninstaller
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"; SKILL_SRC="$ROOT/skills/vector-index"
PYEXEC="$SKILL_SRC/.venv/bin/python"; [ -x "$PYEXEC" ] || PYEXEC="$(command -v python3 || true)"
RM_VENV=0; RM_DAEMON=0
for a in "$@"; do case "$a" in --venv) RM_VENV=1 ;; --daemon) RM_DAEMON=1 ;; esac; done

unlink_skill(){ if [ -L "$1/vector-index" ]; then rm -f "$1/vector-index"; echo "   unlinked $1/vector-index"; fi; }
unlink_file(){ if [ -L "$1" ]; then rm -f "$1"; echo "   unlinked $1"; fi; }

del_json_mcp(){ # $1=config path  $2=top key
  [ -f "$1" ] && [ -n "$PYEXEC" ] || return 0
  "$PYEXEC" - "$1" "$2" <<'PY'
import json, sys
path, key = sys.argv[1:3]
try: cfg = json.load(open(path))
except Exception: sys.exit(0)
if isinstance(cfg.get(key), dict) and cfg[key].pop("vectors", None) is not None:
    with open(path, "w") as f: json.dump(cfg, f, indent=2)
    print("   removed 'vectors' from", path)
PY
}

unlink_skill "$HOME/.claude/skills"
unlink_file "$HOME/.claude/commands/vectors.md"
if command -v claude >/dev/null 2>&1; then claude mcp remove vectors -s user >/dev/null 2>&1 && echo "   removed claude code MCP 'vectors'" || true; fi
unlink_skill "$HOME/.config/opencode/skills"
unlink_file "$HOME/.config/opencode/command/vectors.md"
del_json_mcp "$HOME/.config/opencode/opencode.json" "mcp"
case "$(uname -s)" in
  Darwin) del_json_mcp "$HOME/Library/Application Support/Claude/claude_desktop_config.json" "mcpServers" ;;
  Linux)  del_json_mcp "$HOME/.config/Claude/claude_desktop_config.json" "mcpServers" ;;
esac

[ "$RM_DAEMON" -eq 1 ] && bash "$SKILL_SRC/daemon/uninstall.sh" || true
if [ "$RM_VENV" -eq 1 ]; then rm -rf "$SKILL_SRC/.venv"; echo "   removed $SKILL_SRC/.venv"; fi
echo ">> uninstalled (store at \$VINDEX_HOME left intact)"
