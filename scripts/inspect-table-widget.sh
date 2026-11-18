#!/usr/bin/env bash
#
# Mandatory task gate: the Note kit's GFM table widget in KitFrame (row and column buttons, the
# column menu, keyboard navigation, undo of structural actions, and that each action changes only
# the lines it is about).
#
# Runs e2e/note-table-widget.spec.ts through scripts/lib/run-inspection.sh. It fails, never
# skips, when the Note kit package (public/kits/note-ui) is missing.
# Usage: scripts/inspect-table-widget.sh [extra playwright args]   (HEADED=1, TRACE=1 supported)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-table-widget" "e2e/note-table-widget.spec.ts" "$@"
