#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node/bin:$PWD/node_modules/.bin:$PWD/.tools/bin:$PATH"
export DSH_HOME="$PWD/.tools/dsh-home"
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


PROFILE="$DSH_HOME/profiles/issue-agent"
mkdir -p "$PROFILE/node_modules/@local" "$PROFILE/node_modules/@deepseek-ai"
cp profiles/issue-agent/package.json profiles/issue-agent/cordis.patch.yml "$PROFILE/"
touch "$PROFILE/cordis.yml"
ln -sfn "$PWD/packages/desktop-agent" "$PROFILE/node_modules/@local/desktop-agent"
ln -sfn "$PWD/packages/git-issue-agent" "$PROFILE/node_modules/@local/git-issue-agent"
CUA_MODULES="$DSH_HOME/profiles/desktop-cua/node_modules/@deepseek-ai"
ln -sfn "$CUA_MODULES/dsh-computer-use" "$PROFILE/node_modules/@deepseek-ai/dsh-computer-use"
ln -sfn "$CUA_MODULES/dsh-experimental-computer-use-cua-driver-mcp" "$PROFILE/node_modules/@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp"

dsh --profile issue-agent "$@"
