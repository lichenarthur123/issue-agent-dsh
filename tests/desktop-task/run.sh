#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export PATH="$ROOT/.tools/node/bin:$ROOT/node_modules/.bin:$ROOT/.tools/bin:$PATH"
export DSH_HOME="${DSH_HOME:-$ROOT/.tools/dsh-home}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

export DESKTOP_BROWSER_PROFILE_MODE="${AMASHOP_BROWSER_PROFILE_MODE:-isolated_named}"
export DESKTOP_BROWSER_PROFILE_NAME="${AMASHOP_BROWSER_PROFILE_NAME:-amashop-task}"
if [ -n "${AMASHOP_OBSERVATION_MODE:-}" ]; then
  export DESKTOP_OBSERVATION_MODE="$AMASHOP_OBSERVATION_MODE"
fi

bash "$ROOT/scripts/prepare-profiles.sh"

PROFILE="$DSH_HOME/profiles/issue-agent"
rm -f "$PROFILE/node_modules/@local/desktop-task-once"
ln -s "$ROOT/tests/desktop-task/plugin" "$PROFILE/node_modules/@local/desktop-task-once"

exec node "$ROOT/tests/desktop-task/run.mjs" "$@"