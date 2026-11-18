#!/usr/bin/env bash
# The Motion package must exist; missing packages and replica support fail the spec.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-motion" "e2e/motion-embedded.spec.ts" "e2e/motion-promo.spec.ts" "$@"
