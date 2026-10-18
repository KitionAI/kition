#!/usr/bin/env bash
# Builds a kit's own editor (Kition Kit Standard 6.1: the kit's web/ app and its engine) and puts
# it in public/kits/<kit>-ui, where Kition shows it in an iframe (KitFrame). See docs/kit-sdk.md.
#
#   scripts/build-kit-ui.sh slide
#   scripts/build-kit-ui.sh slide --ui-only  # reuse an already built, unchanged engine
#
# The kit repository defaults to a sibling checkout ../kition-<kit>; set KIT_REPO to use another
# path. Its web/ app links kition-sdk's @kition/kit-ui from a sibling checkout too. A kit whose
# editor is Kition's own (the table kit) builds it from this checkout, or KITION_DIR.
set -euo pipefail
kit="${1:?usage: scripts/build-kit-ui.sh <kit>, for example slide}"
[[ -z "${2:-}" || "${2:-}" == "--ui-only" ]] || { echo "unknown option: $2" >&2; exit 2; }
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kit_repo="${KIT_REPO:-$repo_root/../kition-$kit}"
web="$kit_repo/web"
out="$repo_root/public/kits/$kit-ui"
[[ -f "$web/package.json" ]] || { echo "$web has no kit editor (web/package.json)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
[[ -d "$web/node_modules" ]] || pnpm --dir "$web" install --frozen-lockfile
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$kit_repo/target}"
export KITION_DIR="${KITION_DIR:-$repo_root}"
# C code in the engine's dependencies (psm's assembly, through loro) needs a C compiler that can
# target wasm32; Apple's clang cannot. Use Homebrew's LLVM when it is installed and none is set.
llvm="${HOMEBREW_PREFIX:-/opt/homebrew}/opt/llvm/bin"
if [[ -z "${CC_wasm32_unknown_unknown:-}" && -x "$llvm/clang" ]]; then
  export CC_wasm32_unknown_unknown="$llvm/clang" AR_wasm32_unknown_unknown="$llvm/llvm-ar"
fi
if [[ "${2:-}" == "--ui-only" ]]; then
  compgen -G "$web/public/engine/*_bg.wasm" >/dev/null || { echo "build the engine before using --ui-only" >&2; exit 1; }
else
  pnpm --dir "$web" run engine
fi
pnpm --dir "$web" run build
rm -rf "$out"
mkdir -p "$out"
# The editor and its engine; not the development host or its sample.
cp -R "$web/dist/." "$out/"
rm -rf "$out/dev.html" "$out/sample"
# The kit's licence and notices travel with the package (Apache-2.0 section 4).
cp "$kit_repo/LICENSE" "$kit_repo/NOTICE" "$out/"
kit_id="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$kit_repo/kit.json','utf8')).id)")"
version="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$kit_repo/kit.json','utf8')).version)")"
commit="$(git -C "$kit_repo" rev-parse HEAD)"
printf '{ "kitId": "%s", "version": "%s", "commit": "%s", "entry": "index.html", "protocol": "kition-kit-ui/1" }\n' "$kit_id" "$version" "$commit" > "$out/kit-ui.json"
echo "built $kit_id $version into public/kits/$kit-ui"
