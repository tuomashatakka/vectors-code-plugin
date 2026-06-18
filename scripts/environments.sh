#!/usr/bin/env bash
# Shared environment binding for vectors-plugin installers.
#
# Keep tool-specific paths and detection rules here so adding another harness/LLM
# application is data-only whenever possible. install.sh and uninstall.sh provide
# the action callbacks (link_skill, link_cmd, merge_json_mcp, etc.).

# shellcheck shell=bash

: "${HOME:?HOME must be set}"

vectors_codex_home() {
  printf '%s\n' "${CODEX_HOME:-$HOME/.codex}"
}

# Emit supported environments as tab-separated records:
#   id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor
# detector values:
#   dir_or_cmd:<dir>:<command>  enabled when dir exists or command is present
# mcp_kind values:
#   none | claude_cli | json
vectors_environment_records() {
  local codex_home
  codex_home="$(vectors_codex_home)"
  cat <<EOF_RECORDS
claude_code	Claude Code	dir_or_cmd:$HOME/.claude:claude	$HOME/.claude/skills	$HOME/.claude/commands	claude_cli			
opencode	opencode	dir_or_cmd:$HOME/.config/opencode:opencode	$HOME/.config/opencode/skills	$HOME/.config/opencode/command	json	$HOME/.config/opencode/opencode.json	mcp	opencode
codex	Codex	dir_or_cmd:$codex_home:codex	$codex_home/skills	$codex_home/commands	none			
EOF_RECORDS

  case "$(uname -s)" in
    Darwin)
      printf 'claude_desktop\tClaude Desktop\tdesktop:%s:%s\t\t\tjson\t%s\tmcpServers\tclaude\n' \
        "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
        "/Applications/Claude.app" \
        "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      ;;
    Linux)
      printf 'claude_desktop\tClaude Desktop\tdesktop:%s:%s\t\t\tjson\t%s\tmcpServers\tclaude\n' \
        "$HOME/.config/Claude/claude_desktop_config.json" \
        "" \
        "$HOME/.config/Claude/claude_desktop_config.json"
      ;;
  esac
}

vectors_detector_matches() {
  local detector="$1" kind rest dir cmd cfg app
  kind="${detector%%:*}"
  rest="${detector#*:}"
  case "$kind" in
    dir_or_cmd)
      dir="${rest%%:*}"
      cmd="${rest#*:}"
      [ -d "$dir" ] || command -v "$cmd" >/dev/null 2>&1
      ;;
    desktop)
      cfg="${rest%%:*}"
      app="${rest#*:}"
      [ -e "$cfg" ] || [ -d "$(dirname "$cfg")" ] || { [ -n "$app" ] && [ -d "$app" ]; }
      ;;
    *) return 1 ;;
  esac
}

# Iterate detected environments and invoke a callback with the record fields:
#   callback id label skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor
vectors_each_detected_environment() {
  local callback="$1"
  local id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor
  while IFS=$'\t' read -r id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor; do
    [ -n "$id" ] || continue
    if vectors_detector_matches "$detector"; then
      "$callback" "$id" "$label" "$skill_dir" "$command_dir" "$mcp_kind" "$mcp_path" "$mcp_topkey" "$mcp_flavor"
    fi
  done < <(vectors_environment_records)
}
