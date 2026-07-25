#!/usr/bin/env bash
#
                                            
#
     
                                            
                                                      
                                            
#
     
                                                            
                                             
                                                      
                                                                    
#
                                                 

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPEC="e2e/kitable.spec.ts"

cd "$APP_DIR"

if [[ ! -f "$SPEC" ]]; then
  echo "[inspect-kitable] missing $SPEC under $APP_DIR" >&2
  exit 2
fi

ARGS=(--workers=1 --reporter=list)

if [[ "${HEADED:-0}" == "1" ]]; then
  ARGS+=(--headed)
fi

if [[ "${TRACE:-0}" == "1" ]]; then
  ARGS+=(--trace=on)
fi

EXTRA=("$@")

echo "[inspect-kitable] running $SPEC (workers=1)"
echo "[inspect-kitable] cwd=$APP_DIR"
echo "[inspect-kitable] args=${ARGS[*]}${EXTRA[*]:+ ${EXTRA[*]}}"

START_TS=$(date +%s)
set +e
npx playwright test --config tooling/playwright.config.ts "$SPEC" "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
EXIT_CODE=$?
set -e
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "[inspect-kitable] ✓ all green in ${ELAPSED}s"
else
  echo "[inspect-kitable] ✗ failed (exit=$EXIT_CODE) in ${ELAPSED}s" >&2
  echo "[inspect-kitable] Trace: $APP_DIR/test-results/. HTML report: npx playwright show-report" >&2
fi

exit $EXIT_CODE
