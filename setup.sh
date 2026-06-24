#!/usr/bin/env bash
# vectors-plugin — one-shot installer. Provisions the ENTIRE runtime, NO Docker:
#   • Bun (installed if missing)
#   • PostgreSQL 16 + pgvector  (Homebrew on macOS, apt on Linux) + the `vectors` DB
#   • dependencies + schema, and the global `vectors` CLI on your PATH
#   • the background sync daemon (launchd/systemd)
#   • the MCP server + skill wired into every detected tool (Claude Code/Desktop, …)
#   • the intent-memory hooks (UserPromptSubmit + Stop) wired into Claude Code
#
#   bash setup.sh                 full install (prompts before the daemon)
#   bash setup.sh -y, --yes       non-interactive (install the daemon too)
#   bash setup.sh --no-daemon     everything except the daemon
#   bash setup.sh --no-db         skip Postgres provisioning (use existing $VINDEX_DSN)
#   bash setup.sh --uninstall     remove skill/MCP wiring + daemon (the DB is left intact)
#   bash setup.sh -h, --help      show this help
set -euo pipefail

ASSUME_YES=0; NO_DAEMON=0; NO_DB=0; UNINSTALL=0
while [ $# -gt 0 ]; do case "$1" in
  -y|--yes)      ASSUME_YES=1; shift ;;
  -n|--no-daemon) NO_DAEMON=1; shift ;;
  --no-db)       NO_DB=1; shift ;;
  --uninstall)   UNINSTALL=1; shift ;;
  -h|--help)     awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;;
  *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac; done

cd "$(dirname "$0")"
ROOT="$(pwd)"
SKILL_SRC="$ROOT/skills/vector-index"
MCP_CMD="bun"
MCP_ARG="$ROOT/src/mcp/server.ts"
HOOK_UPS="$ROOT/hooks/user_prompt_submit.ts"
HOOK_STOP="$ROOT/hooks/stop.ts"
OS="$(uname -s)"
DB_NAME="vectors"
DSN="${VINDEX_DSN:-postgres://localhost:5432/$DB_NAME}"
touched=()

say(){ printf '\n>> %s\n' "$*"; }
note(){ printf '   %s\n' "$*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# tool bindings (data-driven via scripts/environments.sh)
# ---------------------------------------------------------------------------
# shellcheck source=scripts/environments.sh
source "$ROOT/scripts/environments.sh"

link_skill(){ mkdir -p "$1"; ln -sfn "$SKILL_SRC" "$1/vector-index"; touched+=("skill  -> $1/vector-index"); }
link_cmd(){   mkdir -p "$1"; ln -sfn "$ROOT/commands/vectors.md" "$1/vectors.md"; touched+=("cmd    -> $1/vectors.md"); }
unlink_skill(){ [ -L "$1/vector-index" ] && { rm -f "$1/vector-index"; note "unlinked $1/vector-index"; } || true; }
unlink_file(){  [ -L "$1" ] && { rm -f "$1"; note "unlinked $1"; } || true; }

merge_json_mcp(){ # $1=config path  $2=top key  $3=flavor
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
del_json_mcp(){ # $1=config path  $2=top key
  [ -f "$1" ] || return 0
  node -e '
const [path, key] = process.argv.slice(1)
const fs = require("fs")
let cfg; try { cfg = JSON.parse(fs.readFileSync(path, "utf8")) } catch { process.exit(0) }
if (cfg[key] && typeof cfg[key] === "object" && cfg[key].vectors !== undefined) {
  delete cfg[key].vectors
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2))
  console.log("   removed vectors from " + path)
}
' "$1" "$2"
}

# Intent-memory hooks (Claude Code only — UserPromptSubmit + Stop are CC events).
# Idempotent: keyed on the hook filename, so re-running never duplicates entries.
merge_claude_hooks(){ # $1=settings.json path
  node -e '
const [path, cmdUps, cmdStop] = process.argv.slice(1)
const fs = require("fs"), p = require("path")
let cfg = {}
try { if (fs.existsSync(path) && fs.statSync(path).size) cfg = JSON.parse(fs.readFileSync(path, "utf8")) } catch {}
const hooks = cfg.hooks ?? (cfg.hooks = {})
const ensure = (event, file, cmd) => {
  const arr = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = [])
  const present = arr.some(g => Array.isArray(g.hooks) && g.hooks.some(h => typeof h.command === "string" && h.command.includes(file)))
  if (!present) arr.push({ hooks: [{ type: "command", command: cmd }] })
}
ensure("UserPromptSubmit", "hooks/user_prompt_submit.ts", "bun \"" + cmdUps + "\"")
ensure("Stop", "hooks/stop.ts", "bun \"" + cmdStop + "\"")
fs.mkdirSync(p.dirname(path), { recursive: true })
fs.writeFileSync(path, JSON.stringify(cfg, null, 2))
' "$1" "$HOOK_UPS" "$HOOK_STOP"
}
del_claude_hooks(){ # $1=settings.json path
  [ -f "$1" ] || return 0
  node -e '
const [path] = process.argv.slice(1)
const fs = require("fs")
let cfg; try { cfg = JSON.parse(fs.readFileSync(path, "utf8")) } catch { process.exit(0) }
if (!cfg.hooks) process.exit(0)
for (const event of ["UserPromptSubmit", "Stop"]) {
  if (!Array.isArray(cfg.hooks[event])) continue
  cfg.hooks[event] = cfg.hooks[event].filter(g => !(Array.isArray(g.hooks) && g.hooks.some(h => typeof h.command === "string" && (h.command.includes("hooks/user_prompt_submit.ts") || h.command.includes("hooks/stop.ts")))))
  if (cfg.hooks[event].length === 0) delete cfg.hooks[event]
}
if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks
fs.writeFileSync(path, JSON.stringify(cfg, null, 2))
console.log("   removed vectors hooks from " + path)
' "$1"
}

bind_environment(){
  local id="$1" label="$2" skill_dir="$3" command_dir="$4" mcp_kind="$5" mcp_path="$6" mcp_topkey="$7" mcp_flavor="$8"
  say "$label"
  [ -n "$skill_dir" ]   && link_skill "$skill_dir"
  [ -n "$command_dir" ] && link_cmd "$command_dir"
  case "$mcp_kind" in
    claude_cli)
      if have claude; then
        claude mcp remove vectors -s user >/dev/null 2>&1 || true
        if claude mcp add vectors -s user -- "$MCP_CMD" "$MCP_ARG" >/dev/null 2>&1; then
          touched+=("mcp    -> claude code (user scope)"); note "registered MCP 'vectors'"
        else
          note "couldn't auto-register MCP — the bundled .mcp.json handles it as a plugin"
        fi
      else
        note "claude CLI not found; run later:  claude mcp add vectors -- $MCP_CMD $MCP_ARG"
      fi ;;
    json)
      merge_json_mcp "$mcp_path" "$mcp_topkey" "$mcp_flavor"
      touched+=("mcp    -> $mcp_path"); note "registered MCP 'vectors'" ;;
    none) ;;
  esac
  # Intent-memory hooks: Claude Code only (its settings.json lives beside skills/).
  if [ "$id" = "claude_code" ]; then
    merge_claude_hooks "$HOME/.claude/settings.json"
    touched+=("hooks  -> $HOME/.claude/settings.json"); note "wired intent-memory hooks"
  fi
}
unbind_environment(){
  local id="$1" label="$2" skill_dir="$3" command_dir="$4" mcp_kind="$5" mcp_path="$6" mcp_topkey="$7" mcp_flavor="$8"
  [ -n "$skill_dir" ]   && unlink_skill "$skill_dir"
  [ -n "$command_dir" ] && unlink_file "$command_dir/vectors.md"
  case "$mcp_kind" in
    claude_cli) have claude && claude mcp remove vectors -s user >/dev/null 2>&1 && note "removed claude code MCP 'vectors'" || true ;;
    json) del_json_mcp "$mcp_path" "$mcp_topkey" ;;
    none) ;;
  esac
  [ "$id" = "claude_code" ] && del_claude_hooks "$HOME/.claude/settings.json"
}

# ---------------------------------------------------------------------------
# uninstall path
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  say "removing skill + MCP wiring from detected tools"
  vectors_each_detected_environment unbind_environment
  [ -f "$SKILL_SRC/daemon/uninstall.sh" ] && bash "$SKILL_SRC/daemon/uninstall.sh" || true
  say "uninstalled (Postgres DB '$DB_NAME' left intact)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1) Bun
# ---------------------------------------------------------------------------
if ! have bun; then
  say "installing Bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
have bun || { echo "!! Bun install failed — see https://bun.sh" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2) PostgreSQL 16 + pgvector  (no Docker)
# ---------------------------------------------------------------------------
wait_pg(){ local i; for i in $(seq 1 30); do pg_isready -q 2>/dev/null && return 0; sleep 1; done; note "postgres not reporting ready — continuing"; }

ensure_postgres(){
  case "$OS" in
    Darwin)
      have brew || { echo "!! Homebrew required for Postgres: https://brew.sh" >&2; exit 1; }
      brew list postgresql@16 >/dev/null 2>&1 || { say "installing postgresql@16"; brew install postgresql@16; }
      brew list pgvector      >/dev/null 2>&1 || { say "installing pgvector";       brew install pgvector; }
      brew services start postgresql@16 >/dev/null 2>&1 || true
      export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
      wait_pg
      createdb "$DB_NAME" 2>/dev/null || true
      psql -d "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;' >/dev/null
      DSN="postgres://localhost:5432/$DB_NAME" ;;
    Linux)
      if ! have psql; then
        say "installing postgresql-16 + pgvector (apt, sudo)"
        sudo apt-get update -y
        sudo apt-get install -y postgresql-16 postgresql-16-pgvector \
          || sudo apt-get install -y postgresql postgresql-contrib
      fi
      sudo systemctl enable --now postgresql >/dev/null 2>&1 || sudo service postgresql start || true
      sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" | grep -q 1 \
        || sudo -u postgres createuser -s "$USER"
      sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
        || createdb "$DB_NAME"
      psql -d "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;' >/dev/null
      DSN="postgres://localhost:5432/$DB_NAME" ;;
    *) note "unsupported OS '$OS' — set VINDEX_DSN to a Postgres 16 + pgvector instance yourself" ;;
  esac
}

if [ "$NO_DB" -eq 0 ]; then
  say "provisioning PostgreSQL + pgvector"
  ensure_postgres
else
  note "skipping Postgres provisioning (--no-db); using VINDEX_DSN=$DSN"
fi
export VINDEX_DSN="$DSN"

# persist DSN into the daemon env file + advise the shell
ENVF="$SKILL_SRC/daemon/ukdb-daemon.env"
[ -f "${ENVF}.example" ] && [ ! -f "$ENVF" ] && cp "${ENVF}.example" "$ENVF" || true
if [ -f "$ENVF" ] && grep -q '^VINDEX_DSN=' "$ENVF"; then
  sed -i.bak "s|^VINDEX_DSN=.*|VINDEX_DSN=$DSN|" "$ENVF" && rm -f "${ENVF}.bak"
else
  printf 'VINDEX_DSN=%s\n' "$DSN" >> "$ENVF"
fi
note "VINDEX_DSN=$DSN  (saved to daemon/ukdb-daemon.env)"
note "persist it in your shell rc:  export VINDEX_DSN=$DSN"

# ---------------------------------------------------------------------------
# 3) dependencies + schema + global CLI
# ---------------------------------------------------------------------------
say "installing dependencies + applying schema"
[ -d node_modules ] || bun install
bun "$ROOT/src/cli/index.ts" setup --no-daemon

say "linking the global 'vectors' CLI"
if bun link >/dev/null 2>&1; then note "linked — run: vectors --help"; else note "bun link failed — use: bun $ROOT/src/cli/index.ts"; fi

# ---------------------------------------------------------------------------
# 4) tool wiring (MCP + skill)
# ---------------------------------------------------------------------------
vectors_each_detected_environment bind_environment

# ---------------------------------------------------------------------------
# 5) background daemon
# ---------------------------------------------------------------------------
if [ "$NO_DAEMON" -eq 0 ]; then
  if [ "$ASSUME_YES" -eq 1 ]; then reply=y
  else read -r -p $'\nStart the background sync daemon now? [Y/n] ' reply || reply=""; fi
  case "${reply:-y}" in
    [nN]*) note "skipped — start later:  vectors daemon start" ;;
    *) bash "$SKILL_SRC/daemon/install.sh" || note "daemon not started — fix daemon/ukdb-daemon.env, then: vectors daemon start" ;;
  esac
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
say "done"
[ ${#touched[@]} -eq 0 ] && note "no editor tools detected — the CLI still works: vectors --help"
for t in "${touched[@]}"; do note "$t"; done
note "verify:  vectors doctor"
note "index a project:  cd <repo> && vectors index <name>"
