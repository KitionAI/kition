#!/usr/bin/env bash
#
# Shared runner for the single-spec Playwright inspections used as task gates.
#
# Usage: run-inspection.sh <label> <spec-path> [extra playwright args...]
#
# - Runs one spec file with one worker so failures are deterministic.
# - Picks a free loopback port for the Vite dev server unless KITION_E2E_PORT
#   is already set, so the gate never collides with a running `pnpm dev`.
# - HEADED=1 opens a visible browser; TRACE=1 records a trace for every test.
# - Proxy handling lives in tooling/playwright.config.ts, not here.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <label> <spec-path> [playwright args...]" >&2
  exit 2
fi

LABEL="$1"
SPEC="$2"
shift 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$APP_DIR"

if [[ ! -f "$SPEC" ]]; then
  echo "[$LABEL] missing $SPEC under $APP_DIR" >&2
  exit 2
fi

if [[ -z "${KITION_E2E_PORT:-}" ]]; then
  KITION_E2E_PORT="$(node - <<'NODE'
const net = require('node:net')
const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port)
  server.close()
})
NODE
)"
  export KITION_E2E_PORT
fi

ARGS=(--workers=1 --reporter=list)

if [[ "${HEADED:-0}" == "1" ]]; then
  ARGS+=(--headed)
fi

if [[ "${TRACE:-0}" == "1" ]]; then
  ARGS+=(--trace=on)
fi

EXTRA=("$@")

echo "[$LABEL] running $SPEC (workers=1)"
echo "[$LABEL] cwd=$APP_DIR"
echo "[$LABEL] port=$KITION_E2E_PORT"
echo "[$LABEL] args=${ARGS[*]}${EXTRA[*]:+ ${EXTRA[*]}}"

START_TS=$(date +%s)
set +e
npx playwright test --config tooling/playwright.config.ts "$SPEC" "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
EXIT_CODE=$?
set -e
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "[$LABEL] ✓ all green in ${ELAPSED}s"
else
  echo "[$LABEL] ✗ failed (exit=$EXIT_CODE) in ${ELAPSED}s" >&2
  echo "[$LABEL] Trace: $APP_DIR/test-results/. HTML report: npx playwright show-report" >&2
fi

exit $EXIT_CODE
