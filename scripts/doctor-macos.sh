#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.tools/node/bin:$ROOT/node_modules/.bin:$ROOT/.tools/bin:$PATH"
export DSH_HOME="${DSH_HOME:-$ROOT/.tools/dsh-home}"

SKIP_MODEL=0
CHECK_GITHUB=0
for arg in "$@"; do
  case "$arg" in
    --skip-model) SKIP_MODEL=1 ;;
    --github) CHECK_GITHUB=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ERRORS=0
WARNINGS=0
ok() { echo "OK   $1"; }
warn() { echo "WARN $1"; WARNINGS=$((WARNINGS + 1)); }
fail() { echo "FAIL $1"; ERRORS=$((ERRORS + 1)); }
need_command() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1: $(command -v "$1")"; else fail "missing command: $1"; fi
}

need_command node
need_command npm
need_command python3
need_command dsh
need_command cua-driver

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then ok "Node.js $(node --version)"; else fail "Node.js 22+ is required; found $(node --version)"; fi
fi
if command -v dsh >/dev/null 2>&1; then
  DSH_VERSION="$(dsh --version)"
  if [ "$DSH_VERSION" = "0.2.2-rc.1" ]; then ok "DSH $DSH_VERSION"; else warn "tested with DSH 0.2.2-rc.1; found $DSH_VERSION"; fi
fi
if command -v cua-driver >/dev/null 2>&1; then
  ok "$(cua-driver --version)"
fi

for file in package-lock.json tests/website/index.html tests/website/serve.sh tests/desktop-task/run.sh tests/desktop-task/cases.mjs; do
  if [ -f "$ROOT/$file" ]; then ok "found $file"; else fail "missing $file"; fi
done

if [ -d /Applications/CuaDriver.app ]; then ok "found /Applications/CuaDriver.app"; else warn "CuaDriver.app is not installed in /Applications"; fi
if [ -d '/Applications/Google Chrome.app' ] || [ -d '/Applications/Microsoft Edge.app' ]; then
  ok "Chrome or Edge is installed"
else
  fail "install Google Chrome or Microsoft Edge"
fi

if [ -d "$DSH_HOME/profiles/desktop-cua/node_modules/@deepseek-ai/dsh-computer-use" ]; then
  ok "desktop-cua profile is initialized"
else
  fail "run bash scripts/prepare-profiles.sh"
fi
if [ -L "$DSH_HOME/profiles/issue-agent/node_modules/@local/desktop-agent" ]; then
  ok "issue-agent profile is initialized"
else
  fail "issue-agent local package link is missing; run bash scripts/prepare-profiles.sh"
fi

if [ -f "$ROOT/.env" ]; then
  set -a
  source "$ROOT/.env"
  set +a
  ok ".env is loaded"
else
  warn ".env is missing; copy .env.example and configure it before running models"
fi

if [ "${CUA_MODEL_API_KEY:-}" = '' ] || [ "${CUA_MODEL_API_KEY:-}" = '<your-api-key>' ]; then
  warn "CUA_MODEL_API_KEY is not configured (only required for the cloud default model)"
fi
if [ "$CHECK_GITHUB" -eq 1 ]; then
  if [ "${GITHUB_REPOSITORY:-}" = '' ] || [ "${GITHUB_REPOSITORY:-}" = 'owner/repo' ]; then fail "GITHUB_REPOSITORY is not configured"; else ok "GitHub repository is configured"; fi
  if [ "${GITHUB_TOKEN:-}" = '' ] || [ "${GITHUB_TOKEN:-}" = '<issues-read-write-token>' ]; then fail "GITHUB_TOKEN is not configured"; else ok "GitHub token is present"; fi
fi

if [ "$SKIP_MODEL" -eq 0 ]; then
  while IFS= read -r base; do
    case "$base" in
      http://*|https://*)
        api_key="${DESKTOP_LOCAL_API_KEY:-local}"
        if [ "$base" = "${CUA_MODEL_BASE_URL:-}" ]; then api_key="${CUA_MODEL_API_KEY:-}"; fi
        if curl -fsS --max-time 8 -H "Authorization: Bearer $api_key" "$base/models" >/dev/null 2>&1; then
          ok "model endpoint responds: $base/models"
        else
          fail "model endpoint is unavailable: $base/models"
        fi
        ;;
      *) warn "non-HTTP model baseURL in profile: $base" ;;
    esac
  done < <(node --input-type=module -e "import {readFileSync} from 'node:fs'; const files=['profiles/issue-agent/cordis.patch.yml','packages/desktop-agent/cordis.patch.yml']; const urls=files.flatMap(file=>[...readFileSync(file,'utf8').matchAll(/baseURL:\s*(\S+)/g)].map(m=>m[1])); console.log([...new Set(urls)].join('\n'))")
fi

if command -v cua-driver >/dev/null 2>&1; then
  if cua-driver status >/dev/null 2>&1; then
    ok "Cua Driver daemon is running"
    if pgrep -f 'cua-driver serve.*--grant existing-profile' >/dev/null; then
      ok "existing-profile authorization is enabled"
    else
      warn "daemon is running without existing-profile authorization; issue-agent.sh will restart it"
    fi
    cua-driver permissions status || warn "review Cua Driver permissions"
  else
    warn "Cua Driver daemon is not running; issue-agent.sh will start it"
  fi
fi

if curl -fsS --max-time 2 http://127.0.0.1:8765/ >/dev/null 2>&1; then
  ok "AmaShop test site is running"
else
  ok "AmaShop test site is not running (the test runner will start it)"
fi

echo "doctor summary: errors=$ERRORS warnings=$WARNINGS"
if [ "$ERRORS" -gt 0 ]; then exit 1; fi
