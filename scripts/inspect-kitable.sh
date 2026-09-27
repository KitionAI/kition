#!/usr/bin/env bash
#
# Inspection gate for .kitable container creation, tree, and table leaf flows.
#
# Runs e2e/kitable.spec.ts through scripts/lib/run-inspection.sh.
# Usage: scripts/inspect-kitable.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-kitable" "e2e/kitable.spec.ts" "$@"
