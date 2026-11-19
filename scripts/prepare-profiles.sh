#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="$ROOT/.tools/node/bin:$ROOT/node_modules/.bin:$ROOT/.tools/bin:$PATH"
export DSH_HOME="${DSH_HOME:-$ROOT/.tools/dsh-home}"

DESKTOP_PROFILE="$DSH_HOME/profiles/desktop-cua"
ISSUE_PROFILE="$DSH_HOME/profiles/issue-agent"

mkdir -p "$DESKTOP_PROFILE/node_modules/@local" "$ISSUE_PROFILE/node_modules/@local" "$ISSUE_PROFILE/node_modules/@deepseek-ai"
cp "$ROOT/profiles/desktop-cua/package.json" "$ROOT/profiles/desktop-cua/cordis.patch.yml" "$DESKTOP_PROFILE/"
cp "$ROOT/profiles/issue-agent/package.json" "$ROOT/profiles/issue-agent/cordis.patch.yml" "$ISSUE_PROFILE/"
node --input-type=module -e "import { readFileSync, writeFileSync } from 'node:fs'; const file = process.argv[1]; const pkg = JSON.parse(readFileSync(file, 'utf8')); pkg.dependencies['@local/desktop-agent'] = 'link:' + process.argv[2]; writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')" "$DESKTOP_PROFILE/package.json" "$ROOT/packages/desktop-agent"
touch "$DESKTOP_PROFILE/cordis.yml" "$ISSUE_PROFILE/cordis.yml"

ln -sfn "$ROOT/packages/desktop-agent" "$DESKTOP_PROFILE/node_modules/@local/desktop-agent"
ln -sfn "$ROOT/packages/desktop-agent" "$ISSUE_PROFILE/node_modules/@local/desktop-agent"
ln -sfn "$ROOT/packages/git-issue-agent" "$ISSUE_PROFILE/node_modules/@local/git-issue-agent"

if [ ! -d "$DESKTOP_PROFILE/node_modules/@deepseek-ai/dsh-computer-use" ]; then
  dsh plugin --profile desktop-cua install
fi

CUA_MODULES="$DESKTOP_PROFILE/node_modules/@deepseek-ai"
for module in dsh-computer-use dsh-experimental-computer-use-cua-driver-mcp; do
  if [ ! -d "$CUA_MODULES/$module" ]; then
    echo "missing $module under $CUA_MODULES after profile installation" >&2
    exit 1
  fi
  ln -sfn "$CUA_MODULES/$module" "$ISSUE_PROFILE/node_modules/@deepseek-ai/$module"
done

echo "Profiles ready under $DSH_HOME/profiles"
