#!/usr/bin/env bash
# Builds a kit's package (its own editor and its engine, public/kits/<kit>-ui) and publishes it as
# the `package-v<version>` Release of the kit's repository: kition-<kit>-<version>.tgz and its lock
# entry, kition-<kit>-<version>.json, which scripts/pin-kits.mjs copies into kits/kits.lock.json.
# See docs/kits.md, section 4b.
#
#   scripts/package-kit.sh photo
#
# It runs only in .github/workflows/kit-package.yml, the reusable workflow each kit repository's
# Package workflow calls; packages are never built on a developer machine. The workflow checks out
# the kit (the commit it was started on) and kition-sdk, kition-tessera and kition-fonts (main)
# beside this repository, and sets GH_TOKEN to the kit repository's workflow token. A version is
# published once: bump `version` in the kit's kit.json to publish a change. Whether it is published
# is decided from the Release's asset names by scripts/kit-release-assets.mjs plan, as the
# workflow's plan job decides it: a Release with both assets is left as it is (the run goes on with
# the headless archives it lacks), and one with only one of them, or neither, is refused.
set -euo pipefail
kit="${1:?usage: scripts/package-kit.sh <kit>}"
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo "scripts/package-kit.sh runs only in the kits' Package workflow (.github/workflows/kit-package.yml)" >&2; exit 2; }
# A package is built from the published @kition/* packages the kit's lockfile pins, never against
# linked checkouts (KITION_LINK=1, see build-kit-ui.sh).
unset KITION_LINK
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
workspace="$(dirname "$repo_root")"
kit_dir="$workspace/kition-$kit"
repository="$(node -e "const kit = require('$repo_root/kits/modules.json')['$kit']; if (!kit) process.exit(1); console.log(kit.repository)")" \
  || { echo "kits/modules.json has no kit \"$kit\"" >&2; exit 2; }
[[ "${GITHUB_REPOSITORY:-}" == "$repository" ]] || { echo "kit $kit is published from $repository, not ${GITHUB_REPOSITORY:-an unknown repository}" >&2; exit 2; }
for checkout in "$kit_dir" "$workspace/kition-sdk" "$workspace/kition-tessera" "$workspace/kition-fonts"; do
  [[ -d "$checkout/.git" ]] || { echo "no checkout at $checkout" >&2; exit 1; }
done
commit_of() { git -C "$1" rev-parse --verify HEAD; }
kit_commit="$(commit_of "$kit_dir")"
sdk_commit="$(commit_of "$workspace/kition-sdk")"
tessera_commit="$(commit_of "$workspace/kition-tessera")"
fonts_commit="$(commit_of "$workspace/kition-fonts")"

version="$(node -p "require('$kit_dir/kit.json').version")"
tag="package-v$version"
asset="kition-$kit-$version.tgz"
metadata="kition-$kit-$version.json"
release_exists() { gh release view "$tag" --repo "$repository" >/dev/null 2>&1; }
assets_file="$(mktemp)"
plan_args=()
if gh release view "$tag" --repo "$repository" --json assets --jq '.assets[].name' > "$assets_file" 2> "$assets_file.error"; then
  plan_args=(--assets "$assets_file")
elif ! grep -q 'release not found' "$assets_file.error"; then
  cat "$assets_file.error" >&2
  exit 1
fi
package_state="$(node "$repo_root/scripts/kit-release-assets.mjs" plan --kit "$kit" --version "$version" "${plan_args[@]}" | sed -n 's/^package=//p')"
if [[ "$package_state" == published ]]; then
  echo "$repository $tag has $asset and $metadata already; they stay as published (bump version in the kit's kit.json to publish a change)"
  exit 0
fi

pnpm --dir "$workspace/kition-tessera" install --frozen-lockfile
pnpm --dir "$workspace/kition-sdk" install --frozen-lockfile
# A published engine must not carry the build machine's paths (panic locations name every source
# file): map the home folder, the Cargo home and the checkouts to neutral prefixes. Later flags win.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$HOME=/home --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$workspace=/src"
KIT_REPO="$kit_dir" KITION_SDK_REPO="$workspace/kition-sdk" "$repo_root/scripts/build-kit-ui.sh" "$kit"

# A package claims only the tier its files back (KHP K17, K19): Agent-ready ships agent/checks.json,
# Agent-ready complete also agent/guide.md.
package="$repo_root/public/kits/$kit-ui"
level="$(node -p "require('$package/kit.json').level ?? 'basic'")"
if [[ "$level" == agent-ready* && ! -f "$package/agent/checks.json" ]] || [[ "$level" == agent-ready-complete && ! -f "$package/agent/guide.md" ]]; then
  echo "$kit claims level $level without the agent files it needs (agent/checks.json, and agent/guide.md at agent-ready-complete); add them to the kit or lower its level" >&2
  exit 1
fi
out="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kition-kit-package.XXXXXX")"
# Without build-kit-ui.sh's local-build stamp: the package's own files only.
tar -C "$repo_root/public/kits" --exclude .kition-package.json -czf "$out/$asset" "$kit-ui"
node -e '
const fs = require("fs")
const crypto = require("crypto")
const [file, outFile, repository, version, tag, asset, commit, sdkCommit, tesseraCommit, fontsCommit] = process.argv.slice(1)
const bytes = fs.readFileSync(file)
const entry = { repository, version, tag, asset, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), commit, sdkCommit, tesseraCommit, fontsCommit }
fs.writeFileSync(outFile, JSON.stringify(entry, null, 2) + "\n")
' "$out/$asset" "$out/$metadata" "$repository" "$version" "$tag" "$asset" "$kit_commit" "$sdk_commit" "$tessera_commit" "$fonts_commit"
echo "packed $asset:"
cat "$out/$metadata"

if release_exists; then
  echo "$repository already has $tag; bump version in the kit's kit.json to publish a change" >&2
  exit 1
fi
gh release create "$tag" "$out/$asset" "$out/$metadata" --repo "$repository" --target "$kit_commit" \
  --title "Kit package $version" \
  --notes "The kit's package (editor and engine) for hosts of the Kit UI protocol, built by the kit's Package workflow from $kit_commit with kition-sdk $sdk_commit, kition-tessera $tessera_commit, and kition-fonts $fonts_commit. $metadata is its entry for Kition's kits/kits.lock.json."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### %s %s\n\n```json\n%s\n```\n' "$repository" "$tag" "$(cat "$out/$metadata")" >> "$GITHUB_STEP_SUMMARY"
fi
echo "published $repository $tag"
