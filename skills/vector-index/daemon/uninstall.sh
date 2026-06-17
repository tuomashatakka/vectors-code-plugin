#!/usr/bin/env bash
# Remove the Unified Knowledge Database daemon service (launchd or systemd).
set -euo pipefail
cd "$(dirname "$0")"
LABEL="com.vectors.ukdb"

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  UID_NUM="$(id -u)"
  echo ">> stopping + removing launchd agent $LABEL"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo ">> removed $PLIST"
  ;;
Linux)
  echo ">> stopping + disabling systemd --user unit ukdb-daemon.service"
  systemctl --user disable --now ukdb-daemon.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/ukdb-daemon.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo ">> removed unit"
  ;;
*)
  echo "!! unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
echo ">> done (logs and your ukdb-daemon.env are left in place)"
