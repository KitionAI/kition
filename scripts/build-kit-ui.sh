#!/usr/bin/env bash
# Builds a kit's own editor (Kition Kit Standard 6.1: the kit's web/ app and its engine) and puts
# it in public/kits/<kit>-ui, where Kition shows it in an iframe (KitFrame). See docs/kit-sdk.md.
#
#   scripts/build-kit-ui.sh slide
#   scripts/build-kit-ui.sh slide --ui-only  # reuse an already built, unchanged engine
#
# The kit repository defaults to a sibling checkout ../kition-<kit>; set KIT_REPO to use another
# path. Its web/ app links kition-sdk's @kition/kit-editor from a sibling checkout too, and kit-editor
# links kition-tessera's components and icons from one beside it (../kition-tessera).
set -euo pipefail
kit="${1:?usage: scripts/build-kit-ui.sh <kit>, for example slide}"
[[ -z "${2:-}" || "${2:-}" == "--ui-only" ]] || { echo "unknown option: $2" >&2; exit 2; }
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kit_repo="${KIT_REPO:-$repo_root/../kition-$kit}"
web="$kit_repo/web"
out="$repo_root/public/kits/$kit-ui"
sdk_repo="${KITION_SDK_REPO:-$kit_repo/../kition-sdk}"
node "$sdk_repo/tools/check-kit-naming.mjs" "$kit_repo/kit.json" --key "$kit"
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
node "$sdk_repo/tools/check-manifest.mjs" "$kit_repo/kit.json" --module "$web/public/engine"
rm -rf "$out"
mkdir -p "$out"
# The editor and its engine; not the development host or its sample.
cp -R "$web/dist/." "$out/"
rm -rf "$out/dev.html" "$out/sample"
# The kit's licence and notices travel with the package (Apache-2.0 section 4).
cp "$kit_repo/LICENSE" "$kit_repo/NOTICE" "$out/"
# The kit's KDM schema (kit.json `model.schema`, platform rule K12) travels with the package as
# model/schema.json: the schema its engine was built with, which hosts and @kition/sdk read.
schema="$(node -p "require('$kit_repo/kit.json').model?.schema ?? ''")"
if [[ -n "$schema" ]]; then
  [[ -f "$kit_repo/$schema" ]] || { echo "$kit_repo/kit.json names model.schema $schema, which is missing" >&2; exit 1; }
  mkdir -p "$out/model"
  cp "$kit_repo/$schema" "$out/model/schema.json"
fi
# An initial local prototype may not have a commit yet. Publishing still builds a pushed commit.
commit="$(git -C "$kit_repo" rev-parse --verify HEAD 2>/dev/null || echo uncommitted)"
# The package's identity, and its brand color for scripts/check-kit-brands.mjs.
node -e '
const fs = require("fs")
const [manifestFile, commit, outFile] = process.argv.slice(1)
const kit = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
const pkg = { kitId: kit.id, version: kit.version, commit, entry: "index.html", protocol: "kition-kit-ui/1", ...(kit.ui?.brand ? { brand: kit.ui.brand } : {}) }
fs.writeFileSync(outFile, JSON.stringify(pkg) + "\n")
' "$kit_repo/kit.json" "$commit" "$out/kit-ui.json"
node "$sdk_repo/tools/check-kit-naming.mjs" "$kit_repo/kit.json" --package "$out" --key "$kit"
# Ship the source manifest with a package-relative schema path so consumers can verify it.
node --input-type=module - "$kit_repo/kit.json" "$out/kit.json" <<'NODE'
import fs from 'node:fs'
const [source, target] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(source, 'utf8'))
if (manifest.model?.schema) manifest.model.schema = 'model/schema.json'
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n')
NODE
kit_id="$(node -p "require('$out/kit-ui.json').kitId")"
version="$(node -p "require('$out/kit-ui.json').version")"
# Marks the package as a local build, so scripts/fetch-kits.mjs never takes it for the published
# one of the same version (docs/kit-sdk.md, section 4b). publish-kit.sh leaves it out of the .tgz.
sdk_commit="$(git -C "${KITION_SDK_REPO:-$kit_repo/../kition-sdk}" rev-parse HEAD 2>/dev/null || echo unknown)"
printf '{ "local": true, "kitCommit": "%s", "sdkCommit": "%s", "builtAt": "%s" }\n' "$commit" "$sdk_commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/.kition-package.json"
echo "built $kit_id $version into public/kits/$kit-ui"
