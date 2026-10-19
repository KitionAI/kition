// The kit packages pinned in kits/kits.lock.json (docs/kit-sdk.md, section 4b): reading the
// lock, and checking a folder of kit packages (public/kits or dist/kits) against it.
import fs from 'node:fs'
import path from 'node:path'

export function readKitLock(repoRoot) {
  const { $comment: _comment, ...kits } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'kits.lock.json'), 'utf8'))
  return kits
}

/** What a kit package's `kit-ui.json` in `kitsDir` says, or null when it is not there. */
function installedKitPackage(kitsDir, kit) {
  try {
    return JSON.parse(fs.readFileSync(path.join(kitsDir, `${kit}-ui`, 'kit-ui.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The stamp in a kit package's folder that says where the package came from. It is not part of
 * the published `.tgz`: scripts/fetch-kits.mjs writes the published package's lock entry,
 * scripts/build-kit-ui.sh marks a local build (`"local": true`), and scripts/publish-kit.sh
 * removes it before packing.
 */
export const KIT_PACKAGE_STAMP = '.kition-package.json'

/** The stamp a fetched package gets: the lock entry it was downloaded and checked against. */
export function publishedKitPackageStamp(pinned) {
  return { version: pinned.version, asset: pinned.asset, sha256: pinned.sha256, commit: pinned.commit, sdkCommit: pinned.sdkCommit }
}

/** Writes the stamp of the kit package `kit` in `kitsDir`. */
export function writeKitPackageStamp(kitsDir, kit, stamp) {
  fs.writeFileSync(path.join(kitsDir, `${kit}-ui`, KIT_PACKAGE_STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
}

function readKitPackageStamp(kitsDir, kit) {
  try {
    return JSON.parse(fs.readFileSync(path.join(kitsDir, `${kit}-ui`, KIT_PACKAGE_STAMP), 'utf8'))
  } catch {
    return null
  }
}

/** Why the stamp of the package in `kitsDir` does not show the pinned published package, or null. */
function kitPackageStampProblem(kitsDir, kit, pinned) {
  const stamp = readKitPackageStamp(kitsDir, kit)
  if (!stamp) return `${kit}: not a fetched package (no ${KIT_PACKAGE_STAMP}); run node scripts/fetch-kits.mjs`
  if (stamp.local) {
    return `${kit}: a local build (scripts/build-kit-ui.sh, kit ${stamp.kitCommit ?? 'unknown commit'}), not the published ${pinned.asset}`
  }
  const expected = publishedKitPackageStamp(pinned)
  const differences = Object.keys(expected).filter((key) => stamp[key] !== expected[key])
  if (differences.length) {
    return `${kit}: differs from the lock (${differences.map((key) => `${key} ${stamp[key] ?? 'missing'} instead of ${expected[key]}`).join(', ')})`
  }
  return null
}

/**
 * Why the package in `kitsDir` is not the pinned one, or null when it is. A package counts as
 * the pinned one only when its `kit-ui.json` and its stamp both match the lock, so a local build
 * of the same version is never taken for the published package. `{ stamp: false }` checks
 * `kit-ui.json` only.
 */
export function kitPackageProblem(kitsDir, kit, pinned, { stamp = true } = {}) {
  const installed = installedKitPackage(kitsDir, kit)
  if (!installed) return `${kit}: not in ${kitsDir}`
  if (installed.kitId !== `kit.${kit}`) return `${kit}: the package is ${installed.kitId}`
  if (installed.version !== pinned.version || installed.commit !== pinned.commit) {
    return `${kit}: ${installed.version} (${installed.commit ?? 'no commit'}) instead of ${pinned.version} (${pinned.commit})`
  }
  return stamp ? kitPackageStampProblem(kitsDir, kit, pinned) : null
}

/**
 * Every difference between `kitsDir` and the lock, and every kit in kits/sdks.json the lock does
 * not pin (except `optional` ones); empty when every kit is there as pinned.
 */
export function kitPackageProblems(repoRoot, kitsDir) {
  const lock = readKitLock(repoRoot)
  const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'sdks.json'), 'utf8'))
  const unpinned = Object.keys(registry).filter((kit) => !lock[kit] && registry[kit].optional !== true).map((kit) => `${kit}: not pinned in kits/kits.lock.json (scripts/publish-kit.sh ${kit})`)
  return [...unpinned, ...Object.entries(lock).map(([kit, pinned]) => kitPackageProblem(kitsDir, kit, pinned)).filter(Boolean)]
}
