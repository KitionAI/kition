#!/usr/bin/env bash
# Builds a kit's own editor (Kition Kit Standard 6.1: the kit's web/ app and its engine) and puts
# it in public/kits/<kit>-ui, where Kition shows it in an iframe (KitFrame). See docs/kit-sdk.md.
#
#   scripts/build-kit-ui.sh presentation
#
# The kit repository defaults to a sibling checkout ../kit-<kit>; set KIT_REPO to use another
# path. Its web/ app links kition-sdk's @kition/kit-ui from a sibling checkout too.
set -euo pipefail
kit="${1:?usage: scripts/build-kit-ui.sh <kit>, for example presentation}"
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kit_repo="${KIT_REPO:-$repo_root/../kit-$kit}"
web="$kit_repo/web"
out="$repo_root/public/kits/$kit-ui"
[[ -f "$web/package.json" ]] || { echo "$web has no kit editor (web/package.json)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
[[ -d "$web/node_modules" ]] || pnpm --dir "$web" install --frozen-lockfile
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$kit_repo/target}"
pnpm --dir "$web" run engine
pnpm --dir "$web" run build
rm -rf "$out"
mkdir -p "$out"
# The editor and its engine; not the development host or its sample.
cp -R "$web/dist/." "$out/"
rm -rf "$out/dev.html" "$out/sample"
kit_id="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$kit_repo/kit.json','utf8')).id)")"
version="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$kit_repo/kit.json','utf8')).version)")"
printf '{ "kitId": "%s", "version": "%s", "entry": "index.html", "protocol": "kition-kit-ui/1" }\n' "$kit_id" "$version" > "$out/kit-ui.json"
printf '*\n' > "$out/.gitignore"
echo "built $kit_id $version into public/kits/$kit-ui"
