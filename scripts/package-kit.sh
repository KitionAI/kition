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
# the kit (the commit its plan job chose: the run's, or the draft's target) and kition-sdk,
# kition-tessera and kition-fonts (main) beside this repository, and sets GH_TOKEN to the kit repository's workflow token. A version is
# published once: bump `version` in the kit's kit.json to publish a change.
#
# It makes the Release a draft, targeting the kit's commit, with the package and its lock entry;
# the workflow's publish job adds the headless archives and the index fragment and publishes the
# draft once it holds every asset (on a repository with GitHub's immutable releases, a published
# Release can gain none). Whether to build is decided from the Release by
# scripts/kit-release-assets.mjs plan, as the workflow's plan job decides it: a draft that has both
# files, or a published Release with its .tgz, is left as it is; a draft without both gets both
# again (a draft is seen by no one); a published Release without its .tgz is refused.
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
# The Release as it is now: none (empty), or its draft state, target and asset names. gh finds a
# draft by its tag name too, although the tag exists only once the draft is published.
release_state() {
  local error
  error="$(mktemp)"
  if gh release view "$tag" --repo "$repository" --json isDraft,isImmutable,targetCommitish,assets > "$1" 2> "$error"; then
    node -e 'const r = require(process.argv[1]); require("fs").writeFileSync(process.argv[2], r.assets.map((a) => a.name).join("\n") + "\n")' "$1" "$1.assets"
  elif grep -q 'release not found' "$error"; then
    rm -f "$1"
  else
    cat "$error" >&2
    exit 1
  fi
}
state_file="$(mktemp)"
release_state "$state_file"
plan_args=()
draft=false
if [[ -f "$state_file" ]]; then
  draft="$(node -p "require('$state_file').isDraft")"
  plan_args=(--assets "$state_file.assets")
  if [[ "$draft" == true ]]; then plan_args+=(--draft); fi
  if [[ "$(node -p "require('$state_file').isImmutable")" == true ]]; then plan_args+=(--immutable); fi
fi
package_state="$(node "$repo_root/scripts/kit-release-assets.mjs" plan --kit "$kit" --version "$version" "${plan_args[@]}" | sed -n 's/^package=//p')"
if [[ "$package_state" == published ]]; then
  echo "$repository $tag has its package already; it stays as it is (bump version in the kit's kit.json to publish a change)"
  exit 0
fi
if [[ "$draft" == true ]]; then
  target="$(node -p "require('$state_file').targetCommitish")"
  [[ "$target" == "$kit_commit" ]] || { echo "the draft $tag targets $target, not $kit_commit, the commit checked out" >&2; exit 1; }
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

# Into the draft: a new one, or the draft this version has (a run that stopped while making it),
# whose package files are replaced as a pair. A Release published meanwhile is never touched.
release_state "$state_file"
notes="The kit's package (editor and engine) for hosts of the Kit UI protocol, built by the kit's Package workflow from $kit_commit with kition-sdk $sdk_commit, kition-tessera $tessera_commit, and kition-fonts $fonts_commit. $metadata is its entry for Kition's kits/kits.lock.json."
if [[ ! -f "$state_file" ]]; then
  gh release create "$tag" "$out/$asset" "$out/$metadata" --repo "$repository" --target "$kit_commit" --draft \
    --title "Kit package $version" --notes "$notes"
elif [[ "$(node -p "require('$state_file').isDraft")" == true ]]; then
  gh release upload "$tag" "$out/$asset" "$out/$metadata" --repo "$repository" --clobber
  gh release edit "$tag" --repo "$repository" --notes "$notes"
else
  echo "$repository $tag was published meanwhile; bump version in the kit's kit.json to publish a change" >&2
  exit 1
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### %s %s (draft)\n\n```json\n%s\n```\n' "$repository" "$tag" "$(cat "$out/$metadata")" >> "$GITHUB_STEP_SUMMARY"
fi
echo "$repository $tag is a draft with $asset and $metadata; the publish job publishes it once it holds every asset"
