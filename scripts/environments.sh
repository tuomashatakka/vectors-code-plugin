#!/usr/bin/env bash
# Shared environment binding for vectors-plugin installers.
#
# Keep tool-specific paths and detection rules here so adding another harness/LLM
# application is data-only whenever possible. install.sh and uninstall.sh provide
# the action callbacks (link_skill, link_cmd, merge_json_mcp, etc.).
#
# Record fields are TAB-separated. Empty fields MUST be written as "-" (a literal
# placeholder) because bash `read` with a whitespace IFS (tab) collapses runs of
# delimiters and would otherwise shift columns. vectors_each_detected_environment
# normalizes "-" back to "" before invoking the callback.

# shellcheck shell=bash

: "${HOME:?HOME must be set}"

vectors_codex_home() {
  printf '%s\n' "${CODEX_HOME:-$HOME/.codex}"
}

# Emit supported environments as tab-separated records:
#   id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor
# detector values:
#   dir_or_cmd:<dir>:<command>  enabled when dir exists or command is present
#   desktop:<config>:<app>      enabled when config (or its dir) or the app exists
# mcp_kind values:
#   none | claude_cli | json
# mcp_flavor values (json kind):
#   claude (mcpServers/{command,args}) | opencode (mcp/{type:local,command:[]}) | vscode (servers/{type:stdio})
vectors_environment_records() {
  local codex_home
  codex_home="$(vectors_codex_home)"

  # --- cross-platform (paths identical on macOS + Linux) ---
  cat <<EOF_RECORDS
claude_code	Claude Code	dir_or_cmd:$HOME/.claude:claude	$HOME/.claude/skills	$HOME/.claude/commands	claude_cli	-	-	-
opencode	opencode	dir_or_cmd:$HOME/.config/opencode:opencode	$HOME/.config/opencode/skills	$HOME/.config/opencode/command	json	$HOME/.config/opencode/opencode.json	mcp	opencode
codex	Codex	dir_or_cmd:$codex_home:codex	$codex_home/skills	$codex_home/commands	none	-	-	-
antigravity	Antigravity	dir_or_cmd:$HOME/.gemini:antigravity	$HOME/.gemini/skills	-	json	$HOME/.antigravity/mcp_config.json	mcpServers	claude
antigravity_ide	Antigravity (gemini-ide)	dir_or_cmd:$HOME/.gemini/antigravity-ide:antigravity	-	-	json	$HOME/.gemini/antigravity-ide/mcp_config.json	mcpServers	claude
antigravity_gemini	Antigravity (gemini)	dir_or_cmd:$HOME/.gemini/antigravity:antigravity	-	-	json	$HOME/.gemini/antigravity/mcp_config.json	mcpServers	claude
antigravity_config	Antigravity (gemini-config)	dir_or_cmd:$HOME/.gemini/config:antigravity	-	-	json	$HOME/.gemini/config/mcp_config.json	mcpServers	claude
EOF_RECORDS

  # --- OS-specific (Claude Desktop + VS Code live in different dirs per OS) ---
  case "$(uname -s)" in
    Darwin)
      printf 'claude_desktop\tClaude Desktop\tdesktop:%s:%s\t-\t-\tjson\t%s\tmcpServers\tclaude\n' \
        "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
        "/Applications/Claude.app" \
        "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      printf 'vscode\tVS Code\tdir_or_cmd:%s:code\t-\t-\tjson\t%s\tservers\tvscode\n' \
        "$HOME/Library/Application Support/Code" \
        "$HOME/Library/Application Support/Code/User/mcp.json"
      ;;
    Linux)
      printf 'claude_desktop\tClaude Desktop\tdesktop:%s:%s\t-\t-\tjson\t%s\tmcpServers\tclaude\n' \
        "$HOME/.config/Claude/claude_desktop_config.json" \
        "" \
        "$HOME/.config/Claude/claude_desktop_config.json"
      printf 'vscode\tVS Code\tdir_or_cmd:%s:code\t-\t-\tjson\t%s\tservers\tvscode\n' \
        "$HOME/.config/Code" \
        "$HOME/.config/Code/User/mcp.json"
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
# The literal "-" placeholder for empty fields is normalized to "" first.
vectors_each_detected_environment() {
  local callback="$1"
  local id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor f
  while IFS=$'\t' read -r id label detector skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor; do
    [ -n "$id" ] || continue
    for f in skill_dir command_dir mcp_kind mcp_path mcp_topkey mcp_flavor; do
      [ "${!f}" = "-" ] && printf -v "$f" '%s' ""
    done
    if vectors_detector_matches "$detector"; then
      "$callback" "$id" "$label" "$skill_dir" "$command_dir" "$mcp_kind" "$mcp_path" "$mcp_topkey" "$mcp_flavor"
    fi
  done < <(vectors_environment_records)
}
