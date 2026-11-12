#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node/bin:$PWD/node_modules/.bin:$PWD/.tools/bin:$PATH"
export DSH_HOME="$PWD/.tools/dsh-home"
set -a; source .env; set +a

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
