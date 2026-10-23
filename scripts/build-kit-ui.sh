#!/usr/bin/env bash
# Builds a kit's own editor (Kition Kit Standard 6.1: the kit's web/ app and its engine) and puts
# it in public/kits/<kit>-ui, where Kition shows it in an iframe (KitFrame). See docs/kit-sdk.md.
#
#   scripts/build-kit-ui.sh slide
#   scripts/build-kit-ui.sh slide --ui-only  # reuse an already built, unchanged engine
#
# The kit repository defaults to a sibling checkout ../kition-<kit>; set KIT_REPO to use another
# path. Its web/ app links kition-sdk's @kition/kit-ui from a sibling checkout too. A kit whose
# editor is Kition's own (the document kit) builds it from this checkout, or KITION_DIR. A kit that
# lives in Kition (`path` in kits/sdks.json, the document kit) is built from that folder of this
# checkout, or of KITION_DIR; its licence is Kition's.
set -euo pipefail
kit="${1:?usage: scripts/build-kit-ui.sh <kit>, for example slide}"
[[ -z "${2:-}" || "${2:-}" == "--ui-only" ]] || { echo "unknown option: $2" >&2; exit 2; }
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
in_kition="$(node -e "const kit = require('$repo_root/kits/sdks.json')['$kit']; console.log(kit && kit.path ? kit.path : '')")"
if [[ -n "$in_kition" ]]; then
  kit_repo="${KITION_DIR:-$repo_root}/$in_kition"
else
  kit_repo="${KIT_REPO:-$repo_root/../kition-$kit}"
fi
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
if [[ -n "$in_kition" ]]; then
  cp "${KITION_DIR:-$repo_root}/LICENSE" "$kit_repo/NOTICE" "$out/"
else
  cp "$kit_repo/LICENSE" "$kit_repo/NOTICE" "$out/"
fi
# The kit's KDM schema (kit.json `model.schema`, platform rule K12) travels with the package as
# model/schema.json: the schema its engine was built with, which hosts and @kition/sdk read.
schema="$(node -p "require('$kit_repo/kit.json').model?.schema ?? ''")"
if [[ -n "$schema" ]]; then
  [[ -f "$kit_repo/$schema" ]] || { echo "$kit_repo/kit.json names model.schema $schema, which is missing" >&2; exit 1; }
  mkdir -p "$out/model"
  cp "$kit_repo/$schema" "$out/model/schema.json"
fi
commit="$(git -C "$kit_repo" rev-parse HEAD)"
# The package's identity, and its brand color for scripts/check-kit-brands.mjs.
node -e '
const fs = require("fs")
const [manifestFile, commit, outFile] = process.argv.slice(1)
const kit = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
const pkg = { kitId: kit.id, version: kit.version, commit, entry: "index.html", protocol: "kition-kit-ui/1", ...(kit.ui?.brand ? { brand: kit.ui.brand } : {}) }
fs.writeFileSync(outFile, JSON.stringify(pkg) + "\n")
' "$kit_repo/kit.json" "$commit" "$out/kit-ui.json"
kit_id="$(node -p "require('$out/kit-ui.json').kitId")"
version="$(node -p "require('$out/kit-ui.json').version")"
# Marks the package as a local build, so scripts/fetch-kits.mjs never takes it for the published
# one of the same version (docs/kit-sdk.md, section 4b). publish-kit.sh leaves it out of the .tgz.
sdk_commit="$(git -C "${KITION_SDK_REPO:-$kit_repo/../kition-sdk}" rev-parse HEAD 2>/dev/null || echo unknown)"
printf '{ "local": true, "kitCommit": "%s", "sdkCommit": "%s", "builtAt": "%s" }\n' "$commit" "$sdk_commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/.kition-package.json"
echo "built $kit_id $version into public/kits/$kit-ui"
