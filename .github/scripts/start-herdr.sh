#!/usr/bin/env bash
# A clean config prevents startup hooks or restored personal sessions in CI.
set -euo pipefail
export XDG_CONFIG_HOME
XDG_CONFIG_HOME=$(mktemp -d "${RUNNER_TEMP:-/tmp}/shahi-herdr-ci.XXXXXX")
export HERDR_SOCKET_PATH="$XDG_CONFIG_HOME/herdr/sessions/shahi-ci/herdr.sock"
nohup herdr --session shahi-ci server > /tmp/herdr-server.log 2>&1 &
herdr_pid=$!
for _ in $(seq 1 60); do
  if [ -S "$HERDR_SOCKET_PATH" ]; then break; fi
  kill -0 "$herdr_pid" || { cat /tmp/herdr-server.log; exit 1; }
  sleep 0.5
done
test -S "$HERDR_SOCKET_PATH" || { echo "herdr did not create its isolated socket" >&2; exit 1; }
{
  echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
  echo "HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH"
} >> "$GITHUB_ENV"
herdr session list
