#!/usr/bin/env bash
#
# inspect-workflow.sh — full-chain Workflow e2e, no API/SSE mocks.
#
# This script intentionally runs e2e/workflow-real.spec.ts instead of the
# legacy mocked workflow.spec.ts. It starts the verified proprietary runtime,
# then Playwright starts Vite through tooling/playwright.config.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_LOG_FILE="${TMPDIR:-/tmp}/kition-workflow-real-api.log"
RUNTIME_CONFIG_TEMPLATE="$APP_DIR/electron/defaults/config.e2e.toml"
SPEC="e2e/workflow-real.spec.ts"
DEFAULT_API_PORT="${KITION_E2E_API_PORT:-18101}"
PERSIST_WORKSPACE="${KITION_WORKFLOW_E2E_PERSIST_WORKSPACE:-0}"

required_env=(
  KITION_E2E_AI_PROVIDER
  KITION_E2E_AI_MODEL
  KITION_E2E_AI_API_KEY
  KITION_SMTP_HOST
  KITION_SMTP_USERNAME
  KITION_SMTP_PASSWORD
  KITION_SMTP_FROM
)

missing=()
for key in "${required_env[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[inspect-workflow] missing required live-service env: ${missing[*]}" >&2
  echo "[inspect-workflow] this suite does not fall back to mocks." >&2
  echo "[inspect-workflow] optional: HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890" >&2
  exit 2
fi

cd "$APP_DIR"

if [[ ! -f "$SPEC" ]]; then
  echo "[inspect-workflow] missing $SPEC under $APP_DIR" >&2
  exit 2
fi

api_started=0
api_pid=""
api_port="$DEFAULT_API_PORT"
api_origin="http://127.0.0.1:${api_port}"
api_health_url="${KITION_E2E_API_HEALTH_URL:-${api_origin}/health}"
api_reset_url="${KITION_E2E_API_RESET_URL:-${api_origin}/api/v1/e2e/reset}"
tmp_config=""
tmp_runtime_dir=""
runtime_binary=""

api_is_healthy() {
  curl -fsS "$api_health_url" >/dev/null 2>&1
}

port_is_busy() {
  local port="$1"
  nc -z 127.0.0.1 "$port" >/dev/null 2>&1
}

find_free_port() {
  local start="${1:-18111}"
  local port="$start"
  while [[ "$port" -lt 18250 ]]; do
    if ! port_is_busy "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

set_api_port() {
  api_port="$1"
  api_origin="http://127.0.0.1:${api_port}"
  api_health_url="${api_origin}/health"
  api_reset_url="${api_origin}/api/v1/e2e/reset"
}

persistent_api_uses_test_workspace() {
  local runtime_json
  runtime_json="$(curl -fsS "${api_origin}/desktop/runtime" 2>/dev/null || true)"
  local expected_workspace="$APP_DIR/test-workspace-desktop"
  local expected_sqlite="$APP_DIR/data/desktop-e2e.db"
  [[ "$runtime_json" == *"\"workspace_dir\":\"$expected_workspace\""* && "$runtime_json" == *"\"sqlite_path\":\"$expected_sqlite\""* ]]
}

make_temp_config() {
  local source_config="$RUNTIME_CONFIG_TEMPLATE"
  if [[ "$PERSIST_WORKSPACE" == "1" ]]; then
    if [[ "$api_port" == "$DEFAULT_API_PORT" ]]; then
      tmp_config="$source_config"
      return 0
    fi
    tmp_runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/kition-workflow-e2e-config.XXXXXX")"
    tmp_config="$tmp_runtime_dir/desktop-e2e.toml"
    awk -v port="$api_port" '
      BEGIN { section="" }
      /^[[:space:]]*\[/ {
        section=$0
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", section)
      }
      section=="[server.http]" && /^[[:space:]]*port[[:space:]]*=/ {
        print "    port = " port
        next
      }
      { print }
    ' "$source_config" >"$tmp_config"
    return 0
  fi

  tmp_runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/kition-workflow-e2e.XXXXXX")"
  tmp_config="$tmp_runtime_dir/desktop-e2e.toml"
  awk -v port="$api_port" -v sqlite_path="$tmp_runtime_dir/desktop-e2e.db" -v upload_dir="$tmp_runtime_dir/uploads" -v workspace_dir="$tmp_runtime_dir/workspace" '
    BEGIN { section="" }
    /^[[:space:]]*\[/ {
      section=$0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", section)
    }
    section=="[server.http]" && /^[[:space:]]*port[[:space:]]*=/ {
      print "    port = " port
      next
    }
    section=="[sqlite]" && /^[[:space:]]*path[[:space:]]*=/ {
      print "path = \"" sqlite_path "\""
      next
    }
    section=="[storage]" && /^[[:space:]]*uploadDir[[:space:]]*=/ {
      print "uploadDir = \"" upload_dir "\""
      next
    }
    section=="[storage]" && /^[[:space:]]*workspaceDir[[:space:]]*=/ {
      print "workspaceDir = \"" workspace_dir "\""
      next
    }
    { print }
  ' "$source_config" >"$tmp_config"
}

if api_is_healthy; then
  if [[ "$PERSIST_WORKSPACE" == "1" ]]; then
    if persistent_api_uses_test_workspace; then
      echo "[inspect-workflow] existing API uses the persistent desktop e2e workspace"
    else
      next_port="$(find_free_port 18111)" || {
        echo "[inspect-workflow] API already responds at $api_health_url but is not using the persistent desktop e2e workspace, and no free fallback port was found." >&2
        exit 2
      }
      echo "[inspect-workflow] API at $api_health_url is not the persistent test-workspace API; starting one on port $next_port"
      set_api_port "$next_port"
    fi
  elif [[ "${KITION_WORKFLOW_E2E_REUSE_API:-0}" != "1" ]]; then
    next_port="$(find_free_port 18111)" || {
      echo "[inspect-workflow] API already responds at $api_health_url and no free fallback port was found." >&2
      exit 2
    }
    echo "[inspect-workflow] API already responds at $api_health_url; starting isolated e2e API on port $next_port"
    set_api_port "$next_port"
  fi
fi

if api_is_healthy; then
  echo "[inspect-workflow] reusing existing API at $api_health_url"
else
  make_temp_config
  runtime_binary="$(node "$APP_DIR/electron/scripts/resolve-runtime-path.mjs")"
  if [[ -z "$runtime_binary" || ! -x "$runtime_binary" ]]; then
    echo "[inspect-workflow] failed to resolve an executable Kition runtime" >&2
    exit 2
  fi
  if [[ "$PERSIST_WORKSPACE" == "1" ]]; then
    echo "[inspect-workflow] starting real API with persistent test-workspace config on port $api_port"
  else
    echo "[inspect-workflow] starting real API with isolated config on port $api_port"
  fi
  (
    cd "$APP_DIR"
    exec "$runtime_binary" --config "$tmp_config" all
  ) >"$API_LOG_FILE" 2>&1 &
  api_pid="$!"
  api_started=1

  for _ in $(seq 1 120); do
    if api_is_healthy; then
      break
    fi
    if ! kill -0 "$api_pid" >/dev/null 2>&1; then
      echo "[inspect-workflow] API exited before becoming healthy. Log: $API_LOG_FILE" >&2
      tail -n 120 "$API_LOG_FILE" >&2 || true
      exit 2
    fi
    sleep 1
  done

  if ! api_is_healthy; then
    echo "[inspect-workflow] timed out waiting for API. Log: $API_LOG_FILE" >&2
    tail -n 120 "$API_LOG_FILE" >&2 || true
    exit 2
  fi
fi

cleanup() {
  if [[ "$api_started" == "1" && -n "$api_pid" ]]; then
    kill "$api_pid" >/dev/null 2>&1 || true
    wait "$api_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$tmp_runtime_dir" ]]; then
    rm -rf "$tmp_runtime_dir"
  fi
}
trap cleanup EXIT

echo "[inspect-workflow] resetting real backend fixtures"
curl -fsS -X POST "$api_reset_url" >/dev/null
export KITION_API_TARGET="$api_origin"
export KITION_E2E_API_BASE_URL="${api_origin}/api/v1"
export KITION_WORKFLOW_E2E_KEEP_ARTIFACTS="${KITION_WORKFLOW_E2E_KEEP_ARTIFACTS:-$PERSIST_WORKSPACE}"

ARGS=(--workers=1 --reporter=list)
if [[ "${HEADED:-0}" == "1" ]]; then
  ARGS+=(--headed)
fi
if [[ "${TRACE:-0}" == "1" ]]; then
  ARGS+=(--trace=on)
fi
EXTRA=("$@")

echo "[inspect-workflow] running $SPEC (workers=1, no page.route mocks)"
npx playwright test --config tooling/playwright.config.ts "$SPEC" "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
