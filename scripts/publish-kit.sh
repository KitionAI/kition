#!/usr/bin/env bash
# Publishes a kit's package (its own editor and its engine, public/kits/<kit>-ui) as a GitHub
# Release asset of the kit's private repository, and pins it in kits/kits.lock.json. Kition's
# release builds download the pinned packages (scripts/fetch-kits.mjs); see docs/kit-sdk.md,
# section 4b.
#
#   scripts/publish-kit.sh photo            build the pushed origin/main and publish it
#   scripts/publish-kit.sh photo --dry-run  build and pack only
#
# It runs on a developer machine, never in the kit repositories' CI. It builds pushed commits
# only: clean clones of the kit, kition-sdk, kition-tessera, and kition-fonts (origin/main, or
# KIT_REF, SDK_REF, TESSERA_REF, and FONTS_REF) side by side in a scratch folder, so local changes
# never reach a package. A version
# is published once; bump `version` in the kit's kit.json to publish a change.
set -euo pipefail
kit="${1:?usage: scripts/publish-kit.sh <kit> [--dry-run]}"
[[ -z "${2:-}" || "${2:-}" == "--dry-run" ]] || { echo "unknown option: $2" >&2; exit 2; }
dry_run="${2:-}"
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
parent="$(dirname "$repo_root")"
kit_repo="${KIT_REPO:-$parent/kition-$kit}"
sdk_repo="${KITION_SDK_REPO:-$parent/kition-sdk}"
fonts_repo="${KITION_FONTS_REPO:-$parent/kition-fonts}"
# kit-editor links its components, tokens, and icons from a kition-tessera checkout beside kition-sdk.
tessera_repo="${KITION_TESSERA_REPO:-$parent/kition-tessera}"
scratch="${KITION_KIT_SCRATCH:-${TMPDIR:-/tmp}}"; scratch="${scratch%/}/kition-kit-publish/$kit"
repository="$(node -e "const kit = require('$repo_root/kits/sdks.json')['$kit']; if (!kit) process.exit(1); console.log(kit.repository)")" \
  || { echo "kits/sdks.json has no kit \"$kit\"" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
# The kits need a newer Rust than some system installs; prefer rustup's stable toolchain.
if stable_cargo="$(rustup which --toolchain stable cargo 2>/dev/null)"; then
  export PATH="$(dirname "$stable_cargo"):$PATH"
fi

# Clones `repo` at `ref` (fetched first; it must be pushed) into the scratch folder as `name`,
# and prints the commit.
clone() {
  local repo="$1" name="$2" ref="$3" commit
  git -C "$repo" fetch -q origin
  commit="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"
  if [[ -z "$(git -C "$repo" branch -r --contains "$commit")" ]]; then
    echo "$name $commit is not pushed" >&2
    exit 1
  fi
  git clone -q --shared --no-checkout "$repo" "$scratch/$name" || exit 1
  # A clone copies only the local branches, which can be behind the pushed commit.
  git -C "$scratch/$name" fetch -q "$repo" '+refs/remotes/origin/*:refs/remotes/source/*' || exit 1
  # `|| exit`: errexit does not reach into the command substitution that calls clone.
  git -C "$scratch/$name" checkout -q --detach "$commit" || exit 1
  echo "$commit"
}

rm -rf "$scratch"
mkdir -p "$scratch"
kit_commit="$(clone "$kit_repo" "kition-$kit" "${KIT_REF:-origin/main}")"
sdk_commit="$(clone "$sdk_repo" kition-sdk "${SDK_REF:-origin/main}")"
tessera_commit="$(clone "$tessera_repo" kition-tessera "${TESSERA_REF:-origin/main}")"
fonts_commit="$(clone "$fonts_repo" kition-fonts "${FONTS_REF:-origin/main}")"
kit_dir="$scratch/kition-$kit"
pnpm --dir "$scratch/kition-tessera" install --frozen-lockfile
pnpm --dir "$scratch/kition-sdk" install --frozen-lockfile
# The kit checkout's build cache, so only the kit's own crates compile again. The engine's SQLite
# needs a C compiler that targets wasm32 (build-kit-ui.sh uses Homebrew's LLVM when it is there).
CARGO_TARGET_DIR="$kit_repo/target" KIT_REPO="$kit_dir" "$repo_root/scripts/build-kit-ui.sh" "$kit"

version="$(node -p "require('$kit_dir/kit.json').version")"
# A package claims only the tier its files back (KHP K17, K19): Agent-ready ships agent/checks.json,
# Agent-ready complete also agent/guide.md.
package="$repo_root/public/kits/$kit-ui"
level="$(node -p "require('$package/kit.json').level ?? 'basic'")"
if [[ "$level" == agent-ready* && ! -f "$package/agent/checks.json" ]] || [[ "$level" == agent-ready-complete && ! -f "$package/agent/guide.md" ]]; then
  echo "$kit claims level $level without the agent files it needs (agent/checks.json, and agent/guide.md at agent-ready-complete); add them to the kit or lower its level" >&2
  exit 1
fi
tag="package-v$version"
asset="kition-$kit-$version.tgz"
# Without build-kit-ui.sh's local-build stamp: the package's own files only.
tar -C "$repo_root/public/kits" --exclude .kition-package.json -czf "$scratch/$asset" "$kit-ui"
sha256="$(shasum -a 256 "$scratch/$asset" | cut -d ' ' -f 1)"
size="$(wc -c < "$scratch/$asset" | tr -d ' ')"
echo "packed $asset: $size bytes, sha256 $sha256, from $repository $kit_commit"
if [[ -n "$dry_run" ]]; then
  echo "dry run: $scratch/$asset is not published"
  exit 0
fi

if gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
  echo "$repository already has $tag; bump version in the kit's kit.json to publish a change" >&2
  exit 1
fi
gh release create "$tag" "$scratch/$asset" --repo "$repository" --target "$kit_commit" \
  --title "Kit package $version" \
  --notes "The kit's package (editor and engine) for hosts of the Kit UI protocol. Built from $kit_commit with kition-sdk $sdk_commit, kition-tessera $tessera_commit, and kition-fonts $fonts_commit."

KIT="$kit" ENTRY="$(printf '{"repository":"%s","version":"%s","tag":"%s","asset":"%s","size":%s,"sha256":"%s","commit":"%s","sdkCommit":"%s","tesseraCommit":"%s","fontsCommit":"%s"}' \
  "$repository" "$version" "$tag" "$asset" "$size" "$sha256" "$kit_commit" "$sdk_commit" "$tessera_commit" "$fonts_commit")" \
  node -e "
const fs = require('fs')
const file = '$repo_root/kits/kits.lock.json'
const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
lock[process.env.KIT] = JSON.parse(process.env.ENTRY)
const { \$comment, ...kits } = lock
const sorted = Object.fromEntries(Object.keys(kits).sort().map((key) => [key, kits[key]]))
fs.writeFileSync(file, JSON.stringify({ \$comment, ...sorted }, null, 2) + '\n')
"
# public/kits/<kit>-ui now holds exactly the published package: stamp it as fetch-kits.mjs would.
KIT="$kit" node --input-type=module -e "
import { publishedKitPackageStamp, readKitLock, writeKitPackageStamp } from '$repo_root/scripts/lib/kitPackages.mjs'
writeKitPackageStamp('$repo_root/public/kits', process.env.KIT, publishedKitPackageStamp(readKitLock('$repo_root')[process.env.KIT]))
"
echo "published $repository $tag and pinned it in kits/kits.lock.json"
