#!/usr/bin/env bash
# The desk page as a standing service: a launchd user agent that runs the
# installed `board serve` at login and restarts it if it dies.
#
#   service/service.sh install     render the agent, (re)start it, wait until the page answers
#   service/service.sh uninstall   stop it and remove the agent
#   service/service.sh restart     restart it (after `just install` put a new binary in place)
#   service/service.sh status      is it loaded, its pid, does the page answer
#   service/service.sh logs        follow its log
#
# macOS only. BOARD_HOME and BOARD_PORT override the defaults.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
label="com.photomancer.board-bench"
domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
plist="$agents_dir/$label.plist"
bin="$HOME/.local/bin/board"
board_home="${BOARD_HOME:-$HOME/.photomancer/desk}"
port="${BOARD_PORT:-4380}"
log="$board_home/log/serve.log"
url="http://127.0.0.1:$port/"

loaded() { launchctl print "$domain/$label" >/dev/null 2>&1; }

answers() { curl -fsS --max-time 2 -o /dev/null "${url}api/state" 2>/dev/null; }

wait_until_answering() {
  for _ in $(seq 1 20); do
    if answers; then echo "service: the desk page answers at $url"; return 0; fi
    sleep 0.5
  done
  echo "service: the page did not answer within 10 s; see $log" >&2
  return 1
}

cmd_install() {
  [[ "$(uname)" == Darwin ]] || { echo "service: launchd is macOS only" >&2; exit 1; }
  [[ -x "$bin" ]] || { echo "service: $bin is missing; run \`just install\` first" >&2; exit 1; }
  # A hand-run `board serve` on the port would keep the agent crash-looping.
  if ! loaded && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "service: something else is listening on :$port (a hand-run board serve?); stop it first:" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null >&2 || true
    exit 1
  fi
  mkdir -p "$agents_dir" "$board_home/log"
  sed -e "s|@BIN@|$bin|g" -e "s|@HOME@|$HOME|g" -e "s|@BOARD_HOME@|$board_home|g" -e "s|@PORT@|$port|g" \
    "$here/$label.plist.tmpl" >"$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  # bootout returns before the label is gone; bootstrapping in that window
  # fails with "5: Input/output error".
  for _ in $(seq 1 10); do loaded || break; sleep 0.5; done
  launchctl bootstrap "$domain" "$plist" 2>/dev/null || { sleep 2; launchctl bootstrap "$domain" "$plist"; }
  wait_until_answering
}

cmd_uninstall() {
  launchctl bootout "$domain/$label" >/dev/null 2>&1 && echo "service: stopped" || echo "service: was not loaded"
  rm -f "$plist"
}

cmd_restart() {
  if ! loaded; then echo "service: not installed (service/service.sh install)" >&2; exit 1; fi
  launchctl kickstart -k "$domain/$label"
  wait_until_answering
}

cmd_status() {
  if loaded; then
    # One tab deep: the agent's own lines, not its endpoints'.
    launchctl print "$domain/$label" | grep -E "^$(printf '\t')(state|pid|last exit code) =" | sed "s/^$(printf '\t')/service: /"
  else
    echo "service: not installed"
  fi
  if answers; then echo "service: the desk page answers at $url"; else echo "service: nothing answers at $url"; fi
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) mkdir -p "$(dirname "$log")"; touch "$log"; tail -f "$log" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
