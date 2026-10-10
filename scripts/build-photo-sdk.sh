#!/usr/bin/env bash
# Builds the Photo engine (kition-photo-sdk in the kit-photo repository) to
# WebAssembly into public/kits/photo-sdk, where the in-page Photo editor loads it.
# KIT_PHOTO_REPO points at the kit-photo checkout; a sibling ../kit-photo is the default.
set -euo pipefail
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kit_photo="${KIT_PHOTO_REPO:-$repo_root/../kit-photo}"
if [[ ! -d "$kit_photo/crates/kition-photo-sdk" ]]; then
  echo "kit-photo not found at $kit_photo; set KIT_PHOTO_REPO" >&2
  exit 1
fi
command -v wasm-pack >/dev/null || { echo "wasm-pack is required: cargo install wasm-pack" >&2; exit 1; }
cd "$kit_photo"
wasm-pack build crates/kition-photo-sdk --target web --release --no-typescript --out-dir "$repo_root/public/kits/photo-sdk"
