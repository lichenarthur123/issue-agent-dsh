#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

DSH_HOME="${DSH_HOME:-$PWD/.tools/dsh-home}"
STATE_DIR="${AGENT_STATE_DIR:-$PWD/artifacts/issue-agent}"
CACHE_DIR="$DSH_HOME/storages/session_projcache/sessions"

PIDS=$(pgrep -f "node .*dsh --profile issue-agent" || true)
if [ -n "$PIDS" ]; then
  kill -TERM $PIDS
  for _ in $(seq 1 20); do
    sleep 0.5
    pgrep -f "node .*dsh --profile issue-agent" >/dev/null || break
  done
  REMAINING=$(pgrep -f "node .*dsh --profile issue-agent" || true)
  if [ -n "$REMAINING" ]; then kill -KILL $REMAINING; fi
fi

rm -f "$STATE_DIR/issues.json" "$STATE_DIR/instance.lock"
rm -rf "$PWD/artifacts/agent"
rm -f "$CACHE_DIR"/*.json

echo "已清空 Issue 队列和 DSH 投影缓存；原始会话与截图未删除。"
