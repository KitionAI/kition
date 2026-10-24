#!/usr/bin/env bash
#
# Mandatory task gate: GFM table widget row and column button regressions.
#
# Runs e2e/table-widget.spec.ts (Kition's native Markdown editor) and e2e/note-table-widget.spec.ts
# (the same scenarios in the Note kit, which replaces it, with a byte check of each structural
# action) through scripts/lib/run-inspection.sh, one after the other; both must pass. The Note kit
# spec fails, never skips, when the Note kit package (public/kits/note-ui) is missing.
# Usage: scripts/inspect-table-widget.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/lib/run-inspection.sh" "inspect-table-widget" "e2e/table-widget.spec.ts" "$@"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-table-widget" "e2e/note-table-widget.spec.ts" "$@"
