#!/usr/bin/env bash
# vectors-plugin — one-command install across Claude Code, opencode & Claude Desktop.
# Installs deps (bun), symlinks the skill into each tool found, and registers the
# bundled MCP server ("vectors", TypeScript on Bun). Idempotent. Reverse: bash uninstall.sh
#
#   bash install.sh                 install deps + wire every tool found; ask about the daemon
#   bash install.sh -y, --yes       also install the background daemon (non-interactive)
#   bash install.sh -n, --no-daemon build + wire only; never touch the daemon
#   bash install.sh -h, --help      show this help
set -euo pipefail

ASSUME_YES=0; NO_DAEMON=0
while [ $# -gt 0 ]; do case "$1" in
  -y|--yes) ASSUME_YES=1; shift ;;
  -n|--no-daemon) NO_DAEMON=1; shift ;;
  -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
  *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac; done

cd "$(dirname "$0")"
ROOT="$(pwd)"
SKILL_SRC="$ROOT/skills/vector-index"
MCP_CMD="bun"
MCP_ARG="$ROOT/src/mcp/server.ts"
touched=()

say(){ printf '\n>> %s\n' "$*"; }
note(){ printf '   %s\n' "$*"; }

command -v bun >/dev/null 2>&1 || { echo "!! bun is required — install it: https://bun.sh" >&2; exit 1; }

# 1) deps + schema -----------------------------------------------------------
# The real setup logic lives in `vectors setup` (src/cli/index.ts); this wires
# editors below. Plain `setup` does NOT wire, so there is no recursion.
say "installing dependencies + applying schema"
bun "$ROOT/src/cli/index.ts" setup --no-daemon

# idempotent skill symlink into a tool's skills dir
link_skill(){ mkdir -p "$1"; ln -sfn "$SKILL_SRC" "$1/vector-index"; touched+=("skill  -> $1/vector-index"); }
# idempotent /vectors command symlink into a tool's commands dir
link_cmd(){ mkdir -p "$1"; ln -sfn "$ROOT/commands/vectors.md" "$1/vectors.md"; touched+=("cmd    -> $1/vectors.md"); }

# add/update the "vectors" MCP entry in a JSON config, preserving everything else
merge_json_mcp(){ # $1=config path  $2=top key (mcpServers|mcp)  $3=flavor (claude|opencode|vscode)
  node -e '
const [path, topkey, flavor, cmd, arg] = process.argv.slice(1)
const fs = require("fs"), p = require("path")
let cfg = {}
try { if (fs.existsSync(path) && fs.statSync(path).size) cfg = JSON.parse(fs.readFileSync(path, "utf8")) } catch {}
const s = cfg[topkey] ?? (cfg[topkey] = {})
if (flavor === "opencode") s.vectors = { type: "local", command: [cmd, arg], enabled: true }
else if (flavor === "vscode") s.vectors = { type: "stdio", command: cmd, args: [arg] }
else s.vectors = { command: cmd, args: [arg] }
fs.mkdirSync(p.dirname(path), { recursive: true })
fs.writeFileSync(path, JSON.stringify(cfg, null, 2))
' "$1" "$2" "$3" "$MCP_CMD" "$MCP_ARG"
}

# 2) harness / LLM application bindings --------------------------------------
# Tool bindings are data-driven from scripts/environments.sh so new applications
# can be added without cloning installer control flow.
# shellcheck source=scripts/environments.sh
source "$ROOT/scripts/environments.sh"

bind_environment(){
  local id="$1" label="$2" skill_dir="$3" command_dir="$4" mcp_kind="$5" mcp_path="$6" mcp_topkey="$7" mcp_flavor="$8"
  say "$label"

  if [ -n "$skill_dir" ]; then link_skill "$skill_dir"; fi
  if [ -n "$command_dir" ]; then link_cmd "$command_dir"; fi

  case "$mcp_kind" in
    claude_cli)
      if command -v claude >/dev/null 2>&1; then
        claude mcp remove vectors -s user >/dev/null 2>&1 || true
        if claude mcp add vectors -s user -- "$MCP_CMD" "$MCP_ARG" >/dev/null 2>&1; then
          touched+=("mcp    -> claude code (user scope)"); note "registered MCP 'vectors'"
        else
          note "couldn't auto-register MCP — installed as a plugin, the bundled .mcp.json handles it"
        fi
      else
        note "claude CLI not found; as a plugin the bundled .mcp.json registers it, or run:"
        note "  claude mcp add vectors -- $MCP_CMD $MCP_ARG"
      fi
      ;;
    json)
      merge_json_mcp "$mcp_path" "$mcp_topkey" "$mcp_flavor"
      touched+=("mcp    -> $mcp_path")
      if [ "$id" = "claude_desktop" ]; then
        note "registered MCP 'vectors' (restart Claude Desktop; uses global search)"
      else
        note "registered MCP 'vectors'"
      fi
      ;;
    none) ;;
  esac
}

vectors_each_detected_environment bind_environment

# 5) background daemon (optional; needs Postgres + pgvector) ------------------
if [ "$NO_DAEMON" -eq 0 ]; then
  if [ "$ASSUME_YES" -eq 1 ]; then reply=y
  else read -r -p $'\nInstall the background sync daemon? (needs Postgres+pgvector — see daemon/README.md) [y/N] ' reply || reply=""; fi
  case "${reply:-n}" in
    [yY]*) bash "$SKILL_SRC/daemon/install.sh" \
             || note "daemon not installed — set UKDB_DSN in daemon/ukdb-daemon.env, then: bash $SKILL_SRC/daemon/install.sh" ;;
    *) note "skipped the daemon. install later: bash $SKILL_SRC/daemon/install.sh" ;;
  esac
fi

# summary --------------------------------------------------------------------
say "done"
if [ ${#touched[@]} -eq 0 ]; then
  note "no supported tools detected (Claude Code / Codex / opencode / Claude Desktop)."
  note "deps are installed — use the CLI: bun $ROOT/src/cli/index.ts --help  (or 'vectors' after: bun link)"
else
  for t in "${touched[@]}"; do note "$t"; done
fi
note "verify:  bun $ROOT/src/cli/index.ts doctor"
