#!/usr/bin/env bash
# Builds a kit's package (its own editor and its engine, public/kits/<kit>-ui) and packs it as the
# npm package @kition/kit-<kit>-ui (the folder <kit>-ui/ and a package.json whose `kition.build`
# names the kit, kition-sdk, kition-tessera and kition-fonts commits it was built from), with
# kition-sdk's tools/kit-npm-package.mjs. See docs/kits.md, section 4b.
#
#   scripts/package-kit.sh photo <out-dir>
#
# It writes the tarball into <out-dir> (kition-kit-<kit>-ui-<version>.tgz, npm pack's name) and never
# publishes: the workflow's publish job does, when the registry has no such version. It runs only in
# .github/workflows/kit-package.yml, the reusable workflow each kit repository's Package workflow
# calls; packages are never built on a developer machine. The workflow checks out the kit (the
# run's commit) and kition-sdk, kition-tessera and kition-fonts (main) beside this repository. A
# version is published once: bump `version` in the kit's kit.json to publish a change.
set -euo pipefail
kit="${1:?usage: scripts/package-kit.sh <kit> <out-dir>}"
out_dir="${2:?usage: scripts/package-kit.sh <kit> <out-dir>}"
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
# The npm package: the <kit>-ui folder without build-kit-ui.sh's local-build stamp, which
# kition-sdk's tool leaves out, and the commits it was built from; `pack` checks the tarball holds
# exactly the folder's files.
stage="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kition-kit-package.XXXXXX")"
mkdir -p "$out_dir"
folder="$(node "$workspace/kition-sdk/tools/kit-npm-package.mjs" ui --from "$package" --out "$stage" \
  --commit "$kit_commit" --sdk-commit "$sdk_commit" --tessera-commit "$tessera_commit" --fonts-commit "$fonts_commit" --repository "$repository")"
packed="$(node "$workspace/kition-sdk/tools/kit-npm-package.mjs" pack --folder "$folder" --out "$out_dir")"
echo "packed $packed"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### %s editor package\n\n```json\n%s\n```\n' "$repository" "$packed" >> "$GITHUB_STEP_SUMMARY"
fi
