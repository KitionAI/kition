#!/usr/bin/env bash
# Builds a kit's engine SDK to WebAssembly into public/kits/<kit>-sdk, where
# Kition's in-page kit editors load it (see docs/kit-sdk.md).
#
#   scripts/build-kit-sdk.sh photo
#
# The kit repository defaults to a sibling checkout ../kit-<kit>; set
# KIT_REPO to use another path. Its SDK crate is crates/kition-<kit>-sdk.
set -euo pipefail
kit="${1:?usage: scripts/build-kit-sdk.sh <kit>, for example photo}"
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kit_repo="${KIT_REPO:-$repo_root/../kit-$kit}"
crate="crates/kition-$kit-sdk"
if [[ ! -d "$kit_repo/$crate" ]]; then
  echo "$crate not found in $kit_repo; set KIT_REPO" >&2
  exit 1
fi
command -v wasm-pack >/dev/null || { echo "wasm-pack is required: cargo install wasm-pack" >&2; exit 1; }
# rust-lld on macOS needs the toolchain's own libLLVM when the toolchain is not on the default path.
if toolchain="$(rustc --print sysroot 2>/dev/null)" && [[ -d "$toolchain/lib" ]]; then
  export DYLD_FALLBACK_LIBRARY_PATH="$toolchain/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
fi
cd "$kit_repo"
wasm-pack build "$crate" --target web --release --no-typescript --out-dir "$repo_root/public/kits/$kit-sdk"
