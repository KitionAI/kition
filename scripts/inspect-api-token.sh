#!/usr/bin/env bash
#
# Kit frame isolation, phase 1: the runtime's API token gate, attacked from a browser page.
#
# Builds the standalone runtime (crates/kition-api) and runs e2e/runtime-api-token.spec.ts through
# scripts/lib/run-inspection.sh with KITION_E2E_RUNTIME_BINARY set, so the spec starts a real
# runtime on a free loopback port. Usage: scripts/inspect-api-token.sh [extra playwright args]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cargo build --quiet --manifest-path "$APP_DIR/Cargo.toml" -p kition-api
export KITION_E2E_RUNTIME_BINARY="$APP_DIR/target/debug/kition-api"
exec "$SCRIPT_DIR/lib/run-inspection.sh" "inspect-api-token" "e2e/runtime-api-token.spec.ts" "$@"
