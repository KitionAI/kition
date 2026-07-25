#!/usr/bin/env bash
#
                                                                    
#
     
                                                             
                                                                  
                                      
                                         
                             
                                                         
#
            
                                              
                                             
#
                                
                                                                                   

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${TMPDIR:-/tmp}/kition-post-task-e2e.log"

                                                           
INPUT=""
if [[ ! -t 0 ]]; then
  INPUT="$(cat || true)"
fi

                                                    
if [[ "$INPUT" == *'"stop_hook_active"'*':'*'true'* ]]; then
  echo "[post-task-e2e] stop_hook_active=true, skipping to avoid recursion" >&2
  exit 0
fi

           
if [[ "${KITION_SKIP_E2E_HOOK:-0}" == "1" ]]; then
  echo "[post-task-e2e] KITION_SKIP_E2E_HOOK=1, skipping e2e inspection" >&2
  exit 0
fi

                                                      
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[post-task-e2e] pnpm not on PATH, skipping" >&2
  exit 0
fi

cd "$APP_DIR"

echo "[post-task-e2e] running pnpm test:table:e2e in $APP_DIR" >&2

if pnpm run test:table:e2e >"$LOG_FILE" 2>&1; then
  echo "[post-task-e2e] ✓ e2e all green" >&2
  exit 0
fi

                                                   
{
  echo ""
echo "[post-task-e2e] E2E FAILED. The task cannot be declared complete."
echo "[post-task-e2e] Full log: $LOG_FILE"
  echo "[post-task-e2e] ---- log tail (last 80 lines) ----"
  tail -n 80 "$LOG_FILE" || true
  echo "[post-task-e2e] ---- end log tail ----"
echo "[post-task-e2e] Fix the failure and retry. Emergency bypass: restart the session with KITION_SKIP_E2E_HOOK=1."
} >&2

exit 2
