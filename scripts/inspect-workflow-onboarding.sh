#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="e2e/workflow-onboarding-actions-real.spec.ts"
API_LOG_FILE="${TMPDIR:-/tmp}/kition-workflow-onboarding-api.log"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kition-workflow-onboarding.XXXXXX")"
API_PORT="${KITION_ONBOARDING_E2E_API_PORT:-18141}"
API_ORIGIN="http://127.0.0.1:${API_PORT}"
UI_PORT="${KITION_ONBOARDING_E2E_UI_PORT:-31141}"
CONFIG_FILE="$RUNTIME_DIR/desktop-e2e.toml"
RUNTIME_CONFIG_TEMPLATE="$APP_DIR/electron/defaults/config.e2e.toml"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

if nc -z 127.0.0.1 "$API_PORT" >/dev/null 2>&1; then
  echo "[workflow-onboarding] port $API_PORT is already in use" >&2
  exit 2
fi

while nc -z 127.0.0.1 "$UI_PORT" >/dev/null 2>&1; do
  UI_PORT=$((UI_PORT + 1))
done

awk -v port="$API_PORT" -v sqlite_path="$RUNTIME_DIR/desktop-e2e.db" -v upload_dir="$RUNTIME_DIR/uploads" -v workspace_dir="$RUNTIME_DIR/workspace" '
  BEGIN { section="" }
  /^[[:space:]]*\[/ { section=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", section) }
  section=="[server.http]" && /^[[:space:]]*port[[:space:]]*=/ { print "    port = " port; next }
  section=="[sqlite]" && /^[[:space:]]*path[[:space:]]*=/ { print "path = \"" sqlite_path "\""; next }
  section=="[storage]" && /^[[:space:]]*uploadDir[[:space:]]*=/ { print "uploadDir = \"" upload_dir "\""; next }
  section=="[storage]" && /^[[:space:]]*workspaceDir[[:space:]]*=/ { print "workspaceDir = \"" workspace_dir "\""; next }
  { print }
' "$RUNTIME_CONFIG_TEMPLATE" > "$CONFIG_FILE"

RUNTIME_BINARY="$(node "$APP_DIR/electron/scripts/resolve-runtime-path.mjs")"
if [[ -z "$RUNTIME_BINARY" || ! -x "$RUNTIME_BINARY" ]]; then
  echo "[workflow-onboarding] failed to resolve an executable Kition runtime" >&2
  exit 2
fi

(
  cd "$APP_DIR"
  exec "$RUNTIME_BINARY" --config "$CONFIG_FILE" all
) >"$API_LOG_FILE" 2>&1 &
API_PID="$!"

for _ in $(seq 1 120); do
  if curl -fsS "$API_ORIGIN/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$API_PID" >/dev/null 2>&1; then
    tail -n 120 "$API_LOG_FILE" >&2 || true
    exit 2
  fi
  sleep 1
done

if ! curl -fsS "$API_ORIGIN/health" >/dev/null 2>&1; then
  tail -n 120 "$API_LOG_FILE" >&2 || true
  exit 2
fi

cd "$APP_DIR"
export KITION_API_TARGET="$API_ORIGIN"
export KITION_E2E_API_BASE_URL="$API_ORIGIN/api/v1"
export KITION_E2E_PORT="$UI_PORT"
npx playwright test --config tooling/playwright.config.ts "$SPEC" --workers=1 --reporter=list "$@"
