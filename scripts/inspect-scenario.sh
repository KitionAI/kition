#!/usr/bin/env bash
#
# Inspection gate for the scenario builder flow.
#
# Runs e2e/scenario.spec.ts through scripts/lib/run-inspection.sh.
# Usage: scripts/inspect-scenario.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-scenario" "e2e/scenario.spec.ts" "$@"
