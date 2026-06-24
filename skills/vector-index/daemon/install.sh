#!/usr/bin/env bash
# Install the Unified Knowledge Database daemon as a background service.
#   macOS  -> a launchd LaunchAgent (com.vectors.ukdb), starts at login + now
#   Linux  -> a systemd --user service (ukdb-daemon.service)
#
# Usage:
#   cp ukdb-daemon.env.example ukdb-daemon.env   # then edit (set UKDB_DSN)
#   bash install.sh
#
# Re-run any time to apply config changes. Uninstall with: bash uninstall.sh
set -euo pipefail
cd "$(dirname "$0")"

DAEMON_DIR="$(pwd)"
SKILL_DIR="$(cd .. && pwd)"
ENV_FILE="${UKDB_ENV_FILE:-$DAEMON_DIR/ukdb-daemon.env}"
LABEL="com.vectors.ukdb"
LOG_DIR="${UKDB_LOG_DIR:-$HOME/Library/Logs}"
[ "$(uname -s)" = "Linux" ] && LOG_DIR="${UKDB_LOG_DIR:-$HOME/.local/state/ukdb}"

# --- preflight --------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  echo "!! no env file at $ENV_FILE" >&2
  echo "   cp ukdb-daemon.env.example ukdb-daemon.env  and set UKDB_DSN" >&2
  exit 1
fi
if ! grep -q '^UKDB_DSN=' "$ENV_FILE"; then
  echo "!! $ENV_FILE must define UKDB_DSN (libpq DSN to the unified DB)" >&2
  exit 1
fi

# The daemon is TypeScript on Bun; resolve an absolute bun path for launchd/systemd.
# Repo root is two levels above the skill dir (skills/vector-index -> repo root).
ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "!! bun not found — install it (https://bun.sh) and re-run" >&2
  exit 1
fi

DAEMON_TS="$ROOT/src/daemon/daemon.ts"
mkdir -p "$LOG_DIR"
LOG_OUT="$LOG_DIR/ukdb-daemon.out.log"
LOG_ERR="$LOG_DIR/ukdb-daemon.err.log"

# --- helper: read KEY=VALUE pairs from the env file (ignores comments/blanks)
read_env_pairs() {
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/[[:space:]]*$//'
}

case "$(uname -s)" in
# ---------------------------------------------------------------------------
Darwin)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"

  # Build the <EnvironmentVariables> dict from the env file (expand ~).
  ENV_DICT=""
  while IFS='=' read -r key val; do
    val="${val/#\~/$HOME}"
    val="${val//&/&amp;}"; val="${val//</&lt;}"; val="${val//>/&gt;}"
    ENV_DICT+="        <key>$key</key><string>$val</string>"$'\n'
  done < <(read_env_pairs)

  node -e '
const [tmpl, out, bun, daemon, lo, le, envdict] = process.argv.slice(1)
const fs = require("fs")
let s = fs.readFileSync(tmpl, "utf8")
s = s.replaceAll("__PYTHON__", bun).replaceAll("__DAEMON__", daemon)
     .replaceAll("__LOG_OUT__", lo).replaceAll("__LOG_ERR__", le)
     .replace("        __ENV_DICT__\n", envdict)
fs.writeFileSync(out, s)
console.log(">> wrote " + out)
' "$DAEMON_DIR/com.vectors.ukdb.plist.template" "$PLIST" \
    "$BUN" "$DAEMON_TS" "$LOG_OUT" "$LOG_ERR" "$ENV_DICT"

  UID_NUM="$(id -u)"
  echo ">> (re)loading launchd agent $LABEL"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  else
    # older macOS fallback
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
  fi
  echo ">> installed. logs: $LOG_OUT  /  $LOG_ERR"
  echo "   status: launchctl print gui/$UID_NUM/$LABEL | head"
  ;;

# ---------------------------------------------------------------------------
Linux)
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/ukdb-daemon.service"
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=Unified Knowledge Database daemon"
    echo "After=network.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "EnvironmentFile=$ENV_FILE"
    echo "ExecStart=$BUN $DAEMON_TS"
    echo "Restart=always"
    echo "RestartSec=10"
    echo "StandardOutput=append:$LOG_OUT"
    echo "StandardError=append:$LOG_ERR"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIT"
  echo ">> wrote $UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now ukdb-daemon.service
  echo ">> installed. logs: $LOG_OUT  /  $LOG_ERR"
  echo "   status: systemctl --user status ukdb-daemon.service"
  echo "   (run 'loginctl enable-linger $USER' to keep it running while logged out)"
  ;;

*)
  echo "!! unsupported OS: $(uname -s). Run the daemon manually:" >&2
  echo "   set -a; . $ENV_FILE; set +a; $BUN $DAEMON_TS" >&2
  exit 1
  ;;
esac
