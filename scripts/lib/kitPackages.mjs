// The kit packages Kition ships (docs/kits.md, section 4b): kits/kits.lock.json pins each kit's
// editor package on npm, `@kition/kit-<kit>-ui` (scripts/lib/kitNpm.mjs), which each kit
// repository's Package workflow publishes. Here: reading and writing the lock, pinning a version
// from the registry's metadata, downloading and unpacking a pinned package into public/kits, and
// checking a folder of kit packages (public/kits or dist/kits) against the lock.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { COMMIT, downloadTarball, INTEGRITY, readVersion, uiPackageName, VERSION } from './kitNpm.mjs'

const LOCK_COMMENT =
  "The kit packages Kition ships: each kit's editor package @kition/kit-<kit>-ui on npm, published by its repository's Package workflow (.github/workflows/kit-package.yml), pinned by scripts/pin-kits.mjs from the registry's metadata and downloaded by scripts/fetch-kits.mjs (docs/kits.md, section 4b)."

/** The fields of a lock entry, in the order kits/kits.lock.json writes them. */
const KIT_LOCK_FIELDS = ['package', 'version', 'integrity', 'commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit']
const BUILD_COMMITS = ['commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit']

/** Why `entry` is not a lock entry of `kit` (an npm pin with every field), or null. */
function lockEntryProblem(kit, entry) {
  if (!entry || typeof entry !== 'object') return `${kit}: not an object`
  const problems = []
  const fields = Object.keys(entry)
  const extra = fields.filter((key) => !KIT_LOCK_FIELDS.includes(key))
  if (extra.length) problems.push(`fields ${extra.join(', ')} are not lock fields (${KIT_LOCK_FIELDS.join(', ')})`)
  if (entry.package !== uiPackageName(kit)) problems.push(`package ${entry.package ?? 'missing'} instead of ${uiPackageName(kit)}`)
  if (!VERSION.test(String(entry.version))) problems.push(`version ${entry.version ?? 'missing'} is not a version`)
  if (!INTEGRITY.test(String(entry.integrity))) problems.push(`integrity ${entry.integrity ?? 'missing'} is not an npm integrity (sha512-<base64>)`)
  const commits = BUILD_COMMITS.filter((key) => !COMMIT.test(String(entry[key])))
  if (commits.length) problems.push(`no valid ${commits.join(', ')}`)
  return problems.length ? `${kit}: ${problems.join('; ')}` : null
}

/**
 * The kits kits/kits.lock.json pins, `{ <kit>: entry }`. Throws when an entry is not an npm pin
 * (`package`, `version`, `integrity`, and the four build commits), naming each.
 */
export function readKitLock(repoRoot) {
  const { $comment: _comment, ...kits } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'kits.lock.json'), 'utf8'))
  const problems = Object.entries(kits)
    .map(([kit, entry]) => lockEntryProblem(kit, entry))
    .filter(Boolean)
  if (problems.length) throw new Error(`kits/kits.lock.json pins packages it cannot fetch from npm; pin them with node scripts/pin-kits.mjs:\n  ${problems.join('\n  ')}`)
  return kits
}

/**
 * The lock entry of `kit` from the registry's metadata of its editor package (`name`, `version`,
 * `dist.integrity`, and the `kition` field the Package workflow wrote), checked to be that kit's
 * editor package, at `version` when one is asked for, with npm's integrity and every build commit.
 */
export function kitLockEntry(kit, metadata, { version } = {}) {
  const name = uiPackageName(kit)
  const problems = []
  if (metadata?.name !== name) problems.push(`name ${metadata?.name ?? 'missing'} instead of ${name}`)
  if (!VERSION.test(String(metadata?.version))) problems.push(`version ${metadata?.version ?? 'missing'} is not a version`)
  else if (version && metadata.version !== version) problems.push(`version ${metadata.version} instead of ${version}`)
  const kition = metadata?.kition ?? {}
  if (kition.kit !== kit || kition.id !== `kit.${kit}`) problems.push(`kition field of kit ${kition.kit ?? 'missing'} (${kition.id ?? 'no id'}) instead of ${kit}`)
  if (kition.role !== 'ui') problems.push(`kition.role ${kition.role ?? 'missing'} instead of ui`)
  if (kition.version !== metadata?.version) problems.push(`kition.version ${kition.version ?? 'missing'} instead of ${metadata?.version}`)
  const integrity = metadata?.dist?.integrity
  if (!INTEGRITY.test(String(integrity))) problems.push(`dist.integrity ${integrity ?? 'missing'} is not an npm integrity (sha512-<base64>)`)
  const commits = BUILD_COMMITS.filter((key) => !COMMIT.test(String(kition.build?.[key])))
  if (commits.length) problems.push(`kition.build has no valid ${commits.join(', ')}`)
  if (problems.length) throw new Error(`${kit}: the registry's ${name} differs (${problems.join(', ')})`)
  return { package: name, version: metadata.version, integrity, ...Object.fromEntries(BUILD_COMMITS.map((key) => [key, kition.build[key]])) }
}

/**
 * The lock entry of `kit` at `version` (or the registry's `latest` of its editor package when no
 * version is given), from the metadata of the first registry of `list` that has it.
 */
export async function pinKit(kit, version, list, fetchImpl = globalThis.fetch) {
  const { registry, value } = await readVersion(list, uiPackageName(kit), version ?? 'latest', fetchImpl)
  return { registry, entry: kitLockEntry(kit, value, { version }) }
}

/**
 * Writes kits/kits.lock.json with `entries` replacing or adding kits: the lock's comment first,
 * kits sorted.
 */
export function writeKitLock(repoRoot, entries) {
  const file = path.join(repoRoot, 'kits', 'kits.lock.json')
  const { $comment: _comment, ...kits } = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...entries }
  const sorted = Object.fromEntries(
    Object.keys(kits)
      .sort()
      .map((key) => [key, kits[key]]),
  )
  fs.writeFileSync(file, `${JSON.stringify({ $comment: LOCK_COMMENT, ...sorted }, null, 2)}\n`)
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
 * the published package: scripts/fetch-kits.mjs writes the lock entry it was fetched by,
 * scripts/build-kit-ui.sh marks a local build (`"local": true`), and kition-sdk's
 * tools/kit-npm-package.mjs leaves it out of the npm package.
 */
export const KIT_PACKAGE_STAMP = '.kition-package.json'

/** The stamp a fetched package gets: the lock entry it was downloaded and checked against. */
export function publishedKitPackageStamp(pinned) {
  return Object.fromEntries(KIT_LOCK_FIELDS.map((key) => [key, pinned[key]]))
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
    return `${kit}: a local build (scripts/build-kit-ui.sh, kit ${stamp.kitCommit ?? 'unknown commit'}), not the published ${pinned.package}@${pinned.version}`
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
 * Every difference between `kitsDir` and the lock, and every kit in kits/modules.json the lock does
 * not pin (except `optional` ones); empty when every kit is there as pinned.
 */
export function kitPackageProblems(repoRoot, kitsDir) {
  const lock = readKitLock(repoRoot)
  const { $comment: _comment, ...registry } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'kits', 'modules.json'), 'utf8'))
  const unpinned = Object.keys(registry)
    .filter((kit) => !lock[kit] && registry[kit].optional !== true)
    .map((kit) => `${kit}: not pinned in kits/kits.lock.json (node scripts/pin-kits.mjs ${kit})`)
  return [...unpinned, ...Object.entries(lock).map(([kit, pinned]) => kitPackageProblem(kitsDir, kit, pinned)).filter(Boolean)]
}

/**
 * Unpacks the editor package `tarball` (npm's .tgz: `package/package.json` and `package/<kit>-ui/`
 * and nothing else) of the pinned `kit` into `kitsDir/<kit>-ui`, replacing what is there, stamps
 * it, and checks it against the lock. Its package.json must be the pinned package, version and
 * build commits.
 */
export function unpackKitPackage(tarball, kitsDir, kit, pinned) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kition-kit-${kit}-`))
  try {
    fs.writeFileSync(path.join(scratch, 'package.tgz'), tarball)
    // By its bare name, in its own folder: GNU tar reads a drive letter in a path as a remote host.
    execFileSync('tar', ['-xzf', 'package.tgz'], { cwd: scratch, stdio: ['ignore', 'ignore', 'inherit'] })
    const top = path.join(scratch, 'package')
    const inside = fs.existsSync(top) ? fs.readdirSync(top).sort() : []
    const folder = `${kit}-ui`
    if (inside.join(',') !== ['package.json', folder].sort().join(',')) throw new Error(`${pinned.package}@${pinned.version} holds ${inside.join(', ') || 'nothing'} under package/, not package.json and ${folder}/`)
    const manifest = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'))
    const build = manifest.kition?.build ?? {}
    const differences = [
      manifest.name !== pinned.package && `name ${manifest.name}`,
      manifest.version !== pinned.version && `version ${manifest.version}`,
      ...BUILD_COMMITS.filter((key) => build[key] !== pinned[key]).map((key) => `kition.build.${key} ${build[key] ?? 'missing'}`),
    ].filter(Boolean)
    if (differences.length) throw new Error(`${pinned.package}@${pinned.version}: its package.json differs from the lock (${differences.join(', ')})`)
    const target = path.join(kitsDir, folder)
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(kitsDir, { recursive: true })
    fs.cpSync(path.join(top, folder), target, { recursive: true })
    writeKitPackageStamp(kitsDir, kit, publishedKitPackageStamp(pinned))
    const problem = kitPackageProblem(kitsDir, kit, pinned)
    if (problem) throw new Error(problem)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Downloads the pinned editor package of `kit` from the first registry of `list` that serves it
 * with the pinned integrity, and unpacks it into `kitsDir/<kit>-ui`. Answers the registry used.
 */
export async function fetchKitPackage(kit, pinned, kitsDir, list, fetchImpl = globalThis.fetch) {
  const { registry, value } = await downloadTarball(list, pinned.package, pinned.version, pinned.integrity, fetchImpl)
  unpackKitPackage(value, kitsDir, kit, pinned)
  return registry
}
