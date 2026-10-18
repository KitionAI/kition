#!/usr/bin/env bash
# Checks that the crates a table kit compiles into its WebAssembly engine still build for
# wasm32-unknown-unknown (part of `pnpm check:desktop`).
#
#   scripts/check-wasm.sh
#
# SQLite's C code (rusqlite's bundled build) needs a C compiler that can target wasm32; Apple's
# clang cannot. Set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown, or install LLVM
# (Homebrew `llvm`), which is used when it is found. A machine without the Rust target or such a
# compiler skips the check with a notice; KITION_REQUIRE_WASM_CHECK=1 makes that an error.
set -euo pipefail
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
crates=(kition-kitable kition-table-api)

skip() {
  echo "check-wasm: skipped: $1" >&2
  if [[ "${KITION_REQUIRE_WASM_CHECK:-}" == "1" ]]; then
    exit 1
  fi
  exit 0
}

libdir="$(rustc --print target-libdir --target wasm32-unknown-unknown 2>/dev/null || true)"
if [[ -z "$libdir" ]] || ! compgen -G "$libdir/libcore-*" >/dev/null; then
  skip "the Rust target wasm32-unknown-unknown is not installed (rustup target add wasm32-unknown-unknown)"
fi

if [[ -z "${CC_wasm32_unknown_unknown:-}" ]]; then
  for llvm in "${HOMEBREW_PREFIX:-/opt/homebrew}/opt/llvm/bin" /usr/local/opt/llvm/bin; do
    if [[ -x "$llvm/clang" ]]; then
      export CC_wasm32_unknown_unknown="$llvm/clang" AR_wasm32_unknown_unknown="$llvm/llvm-ar"
      break
    fi
  done
fi
cc="${CC_wasm32_unknown_unknown:-clang}"
if ! command -v "$cc" >/dev/null || ! echo 'int x;' | "$cc" --target=wasm32-unknown-unknown -x c -c -o /dev/null - 2>/dev/null; then
  skip "no C compiler for wasm32 ($cc cannot target it); install LLVM or set CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown"
fi

args=()
for crate in "${crates[@]}"; do
  args+=(-p "$crate")
done
cd "$repo_root"
cargo check --target wasm32-unknown-unknown "${args[@]}"
