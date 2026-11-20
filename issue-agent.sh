#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node/bin:$PWD/node_modules/.bin:$PWD/.tools/bin:$PATH"
export DSH_HOME="$PWD/.tools/dsh-home"
# 网关 key 只放在仓库外；存在时先加载，随后 .env 可覆盖。
if [ -f "$HOME/.workbench/relay.env" ]; then
  set -a; source "$HOME/.workbench/relay.env"; set +a
fi
set -a; source .env; set +a
export DESKTOP_THINKING_MODE="${DESKTOP_THINKING_MODE:-always}"

driver_ready_with_grant() {
  cua-driver status >/dev/null 2>&1 \
    && pgrep -f 'cua-driver serve.*--grant existing-profile' >/dev/null
}

mkdir -p log
DRIVER_PID=''
if driver_ready_with_grant; then
  echo "Reusing the Cua Driver daemon that already has existing-profile authorization."
else
  cua-driver stop >/dev/null 2>&1 || true
  cua-driver serve --grant existing-profile >log/cua-driver.log 2>&1 &
  DRIVER_PID=$!

  DRIVER_READY=''
  for _ in {1..30}; do
    if driver_ready_with_grant; then
      DRIVER_READY=1
      break
    fi
    if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [[ -z "$DRIVER_READY" ]]; then
    cua-driver stop >/dev/null 2>&1 || true
    echo "Cua Driver failed to start with --grant existing-profile; see log/cua-driver.log" >&2
    exit 1
  fi
  echo "Cua Driver is running with existing-profile authorization (pid $DRIVER_PID)."
fi


bash "$PWD/scripts/prepare-profiles.sh"

dsh --profile issue-agent "$@"
