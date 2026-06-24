#!/usr/bin/env bash
# Reverse install.sh: drop the "vectors" MCP entry + skill symlink from each tool.
# Leaves the on-disk store ($VINDEX_HOME) and the daemon DB intact by design.
#
#   bash uninstall.sh            unlink skill + remove MCP entries from every tool
#   bash uninstall.sh --deps     ...and also delete node_modules
#   bash uninstall.sh --daemon   ...and also run the daemon uninstaller
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"; SKILL_SRC="$ROOT/skills/vector-index"
RM_DEPS=0; RM_DAEMON=0
for a in "$@"; do case "$a" in --deps|--venv) RM_DEPS=1 ;; --daemon) RM_DAEMON=1 ;; esac; done

unlink_skill(){ if [ -L "$1/vector-index" ]; then rm -f "$1/vector-index"; echo "   unlinked $1/vector-index"; fi; }
unlink_file(){ if [ -L "$1" ]; then rm -f "$1"; echo "   unlinked $1"; fi; }

del_json_mcp(){ # $1=config path  $2=top key
  [ -f "$1" ] || return 0
  node -e '
const [path, key] = process.argv.slice(1)
const fs = require("fs")
let cfg
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")) } catch { process.exit(0) }
if (cfg[key] && typeof cfg[key] === "object" && cfg[key].vectors !== undefined) {
  delete cfg[key].vectors
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2))
  console.log("   removed 'vectors' from " + path)
}
' "$1" "$2"
}

# Tool bindings are data-driven from scripts/environments.sh to mirror install.sh.
# shellcheck source=scripts/environments.sh
source "$ROOT/scripts/environments.sh"

unbind_environment(){
  local id="$1" label="$2" skill_dir="$3" command_dir="$4" mcp_kind="$5" mcp_path="$6" mcp_topkey="$7" mcp_flavor="$8"
  [ -n "$skill_dir" ] && unlink_skill "$skill_dir"
  [ -n "$command_dir" ] && unlink_file "$command_dir/vectors.md"
  case "$mcp_kind" in
    claude_cli)
      if command -v claude >/dev/null 2>&1; then claude mcp remove vectors -s user >/dev/null 2>&1 && echo "   removed claude code MCP 'vectors'" || true; fi
      ;;
    json)
      del_json_mcp "$mcp_path" "$mcp_topkey"
      ;;
    none) ;;
  esac
}

vectors_each_detected_environment unbind_environment

[ "$RM_DAEMON" -eq 1 ] && bash "$SKILL_SRC/daemon/uninstall.sh" || true
if [ "$RM_DEPS" -eq 1 ]; then rm -rf "$ROOT/node_modules"; echo "   removed $ROOT/node_modules"; fi
echo ">> uninstalled (store at \$VINDEX_HOME left intact)"
