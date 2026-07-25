#!/usr/bin/env bash
#
                                                       
#
     
                                                              
                                          
                                                                    
                                                          
                                                
#
     
                                                           
                                            
                                                           
                                                                         
#
                                                          

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="e2e/table-widget.spec.ts"

cd "$APP_DIR"

if [[ ! -f "$SPEC" ]]; then
  echo "[inspect-table-widget] missing $SPEC under $APP_DIR" >&2
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

echo "[inspect-table-widget] running $SPEC (workers=1)"
echo "[inspect-table-widget] cwd=$APP_DIR"
echo "[inspect-table-widget] port=$KITION_E2E_PORT"
echo "[inspect-table-widget] args=${ARGS[*]}${EXTRA[*]:+ ${EXTRA[*]}}"

START_TS=$(date +%s)
set +e
npx playwright test --config tooling/playwright.config.ts "$SPEC" "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
EXIT_CODE=$?
set -e
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "[inspect-table-widget] ✓ all green in ${ELAPSED}s"
else
  echo "[inspect-table-widget] ✗ failed (exit=$EXIT_CODE) in ${ELAPSED}s" >&2
  echo "[inspect-table-widget] Trace: $APP_DIR/test-results/. HTML report: npx playwright show-report" >&2
fi

exit $EXIT_CODE
