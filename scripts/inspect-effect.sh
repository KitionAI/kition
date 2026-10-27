#!/usr/bin/env bash
# The Effect package must exist; missing packages and replica support fail the spec.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-effect" "e2e/effect-embedded.spec.ts" "e2e/effect-promo.spec.ts" "$@"
