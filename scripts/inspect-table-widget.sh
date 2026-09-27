#!/usr/bin/env bash
#
# Mandatory task gate: GFM table widget row and column button regressions.
#
# Runs e2e/table-widget.spec.ts through scripts/lib/run-inspection.sh.
# Usage: scripts/inspect-table-widget.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-table-widget" "e2e/table-widget.spec.ts" "$@"
