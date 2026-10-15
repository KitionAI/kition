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

/** Why the package in `kitsDir` is not the pinned one, or null when it is. */
export function kitPackageProblem(kitsDir, kit, pinned) {
  const installed = installedKitPackage(kitsDir, kit)
  if (!installed) return `${kit}: not in ${kitsDir}`
  if (installed.kitId !== `kit.${kit}`) return `${kit}: the package is ${installed.kitId}`
  if (installed.version !== pinned.version || installed.commit !== pinned.commit) {
    return `${kit}: ${installed.version} (${installed.commit ?? 'no commit'}) instead of ${pinned.version} (${pinned.commit})`
  }
  return null
}

/**
 * Every difference between `kitsDir` and the lock, and every kit in kits/sdks.json the lock does
 * not pin; empty when every kit is there as pinned.
 */
export function kitPackageProblems(repoRoot, kitsDir) {
  const lock = readKitLock(repoRoot)
  const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'sdks.json'), 'utf8'))
  const unpinned = Object.keys(registry).filter((kit) => !lock[kit]).map((kit) => `${kit}: not pinned in kits/kits.lock.json (scripts/publish-kit.sh ${kit})`)
  return [...unpinned, ...Object.entries(lock).map(([kit, pinned]) => kitPackageProblem(kitsDir, kit, pinned)).filter(Boolean)]
}
