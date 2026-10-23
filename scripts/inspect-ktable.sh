#!/usr/bin/env bash
#
# Inspection gate for tables: Kition around the Table kit (creating a .ktable file, saving it,
# host writes arriving live outside the person's undo, host/generate, and host/action).
#
# Runs e2e/table-kit.spec.ts through scripts/lib/run-inspection.sh. It fails, never skips, when
# the Table kit package (public/kits/table-ui) is missing.
# Usage: scripts/inspect-ktable.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-ktable" "e2e/table-kit.spec.ts" "$@"
