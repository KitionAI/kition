// The kit packages Kition ships (docs/kits.md, section 4b). kits/kits.lock.json pins each kit in
// one of two forms:
//
// - npm (scripts/pin-kits.mjs writes it): the kit's packages on npm, named from the kit and the
//   entry's `scope` by scripts/lib/kitNpm.mjs (`uiPackageName`, `headlessPackageName`: in @kition
//   `@kition/kit-<kit>-ui` and `@kition/kit-<kit>-<platform>`, in any other scope `<scope>/<kit>` and
//   `<scope>/<kit>-<platform>`), each kit repository's Package workflow publishes them:
//
//     "note": {
//       "scope": "@kitionstage", "version": "0.1.5",
//       "commit": "<40 hex>", "sdkCommit": "<40 hex>", "tesseraCommit": "<40 hex>", "fontsCommit": "<40 hex>",
//       "editor": { "integrity": "sha512-<base64>", "size": <tarball bytes> },
//       "platforms": { "darwin-arm64": { "integrity": "sha512-<base64>", "size": <tarball bytes> }, ... }
//     }
//
//   The editor package's tarball holds `package/package.json` and `package/<kit>-ui/`, which Kition
//   ships in public/kits; each platform's holds kit.json and the headless executable.
// - release, read until every kit is published on npm in the new layout: a GitHub Release asset of
//   the kit's repository (`repository`, `version`, `tag`, `asset`, `size`, `sha256` and the four build
//   commits), downloaded from https://github.com/<repository>/releases/download/<tag>/<asset>.
//
// Here: reading and writing the lock, pinning a kit from the registry, downloading and unpacking a
// pinned package into public/kits (and an npm pin's platform packages into a folder of their own),
// and checking a folder of kit packages (public/kits or dist/kits) against the lock.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkScope, COMMIT, downloadTarball, firstRegistry, headlessPackageName, INTEGRITY, integrityOf, npmScope, registryVersion, uiPackageName, VERSION } from './kitNpm.mjs'
import { HEADLESS_PLATFORMS } from './kitPackageBuild.mjs'

const LOCK_COMMENT =
  "The kit packages Kition ships, pinned by scripts/pin-kits.mjs and downloaded by scripts/fetch-kits.mjs (docs/kits.md, section 4b). An npm pin (scope, version, the four build commits, and the npm integrity and tarball size of the editor package and of each platform's headless package) names its packages from the kit and the scope; a Release pin (repository, tag, asset, size, sha256) is a GitHub Release asset of the kit's repository, read until every kit is pinned on npm."

/** The build commits every pin carries, as the package's `kition.build` names them. */
const BUILD_COMMITS = ['commit', 'sdkCommit', 'tesseraCommit', 'fontsCommit']
/** The fields of an npm pin, in the order kits/kits.lock.json writes them. */
const NPM_FIELDS = ['scope', 'version', ...BUILD_COMMITS, 'editor', 'platforms']
/** The fields of a Release pin, in that order. */
const RELEASE_FIELDS = ['repository', 'version', 'tag', 'asset', 'size', 'sha256', ...BUILD_COMMITS]
/** The platforms a kit's headless package is published for (scripts/lib/kitPackageBuild.mjs). */
export const PLATFORMS = HEADLESS_PLATFORMS.map(({ platform }) => platform)

/** `release` for a GitHub Release pin (it names a repository), else `npm`. */
export const lockForm = (entry) => (entry && typeof entry === 'object' && 'repository' in entry ? 'release' : 'npm')

const isSize = (value) => Number.isSafeInteger(value) && value > 0

/** Why `tarball` (`{ integrity, size }`) is not an npm tarball's pin, or null. */
function tarballProblem(what, tarball) {
  if (!tarball || typeof tarball !== 'object') return `${what} is not { integrity, size }`
  const problems = []
  const extra = Object.keys(tarball).filter((key) => !['integrity', 'size'].includes(key))
  if (extra.length) problems.push(`${what} has fields ${extra.join(', ')} beside integrity and size`)
  if (!INTEGRITY.test(String(tarball.integrity))) problems.push(`${what}.integrity ${tarball.integrity ?? 'missing'} is not an npm integrity (sha512-<base64>)`)
  if (!isSize(tarball.size)) problems.push(`${what}.size ${tarball.size ?? 'missing'} is not a size in bytes`)
  return problems.length ? problems.join('; ') : null
}

/** Why `entry` is not a lock entry of `kit` (an npm or a Release pin with every field), or null. */
function lockEntryProblem(kit, entry) {
  if (!entry || typeof entry !== 'object') return `${kit}: not an object`
  const release = lockForm(entry) === 'release'
  const fields = release ? RELEASE_FIELDS : NPM_FIELDS
  const problems = []
  const extra = Object.keys(entry).filter((key) => !fields.includes(key))
  if (extra.length) problems.push(`fields ${extra.join(', ')} are not ${release ? 'Release' : 'npm'} pin fields (${fields.join(', ')})`)
  if (!VERSION.test(String(entry.version))) problems.push(`version ${entry.version ?? 'missing'} is not a version`)
  const commits = BUILD_COMMITS.filter((key) => !COMMIT.test(String(entry[key])))
  if (commits.length) problems.push(`no valid ${commits.join(', ')}`)
  if (release) {
    const expected = { repository: `KitionAI/kition-${kit}`, tag: `package-v${entry.version}`, asset: `kition-${kit}-${entry.version}.tgz` }
    for (const [key, value] of Object.entries(expected)) if (entry[key] !== value) problems.push(`${key} ${entry[key] ?? 'missing'} instead of ${value}`)
    if (!isSize(entry.size)) problems.push(`size ${entry.size ?? 'missing'} is not a size in bytes`)
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) problems.push(`sha256 ${entry.sha256 ?? 'missing'} is not a SHA-256`)
  } else {
    try {
      checkScope(entry.scope, 'scope')
      uiPackageName(kit, entry.scope)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    const editor = tarballProblem('editor', entry.editor)
    if (editor) problems.push(editor)
    if (!entry.platforms || typeof entry.platforms !== 'object' || Array.isArray(entry.platforms)) {
      problems.push('platforms is not { <platform>: { integrity, size } }')
    } else {
      for (const [platform, tarball] of Object.entries(entry.platforms)) {
        if (!PLATFORMS.includes(platform)) problems.push(`platform ${platform} is not one of ${PLATFORMS.join(', ')}`)
        const problem = tarballProblem(`platforms.${platform}`, tarball)
        if (problem) problems.push(problem)
      }
    }
  }
  return problems.length ? `${kit}: ${problems.join('; ')}` : null
}

/**
 * The kits the lock file `file` pins, `{ <kit>: entry }`. Throws when an entry is neither an npm
 * pin nor a Release pin with every field, naming each.
 */
export function readKitLockFile(file) {
  const { $comment: _comment, ...kits } = JSON.parse(fs.readFileSync(file, 'utf8'))
  const problems = Object.entries(kits)
    .map(([kit, entry]) => lockEntryProblem(kit, entry))
    .filter(Boolean)
  if (problems.length) throw new Error(`${path.basename(file)} pins packages it cannot fetch; pin them with node scripts/pin-kits.mjs:\n  ${problems.join('\n  ')}`)
  return kits
}

/** The kits kits/kits.lock.json pins (`readKitLockFile`). */
function readKitLock(repoRoot) {
  return readKitLockFile(path.join(repoRoot, 'kits', 'kits.lock.json'))
}

/** How a pin names what it downloads: `<package>@<version>`, or a Release pin's asset. */
export function pinnedPackage(kit, pinned) {
  return lockForm(pinned) === 'release' ? `${pinned.repository} ${pinned.asset}` : `${uiPackageName(kit, pinned.scope)}@${pinned.version}`
}

/** The pin of an npm tarball's bytes: `{ integrity, size }`. */
const tarballPin = (bytes) => ({ integrity: integrityOf(bytes), size: bytes.length })

/** Problems with the `kition` field of a published package's metadata, as an array. */
function kitionProblems(kit, metadata, { role, platform }) {
  const kition = metadata?.kition ?? {}
  const problems = []
  if (kition.kit !== kit || kition.id !== `kit.${kit}`) problems.push(`kition field of kit ${kition.kit ?? 'missing'} (${kition.id ?? 'no id'}) instead of ${kit}`)
  if (kition.role !== role) problems.push(`kition.role ${kition.role ?? 'missing'} instead of ${role}`)
  if (kition.version !== metadata?.version) problems.push(`kition.version ${kition.version ?? 'missing'} instead of ${metadata?.version}`)
  if (platform && kition.platform !== platform) problems.push(`kition.platform ${kition.platform ?? 'missing'} instead of ${platform}`)
  if (!INTEGRITY.test(String(metadata?.dist?.integrity))) problems.push(`dist.integrity ${metadata?.dist?.integrity ?? 'missing'} is not an npm integrity (sha512-<base64>)`)
  return problems
}

/**
 * The build of `kit`'s editor package from the registry's metadata (`name`, `version`,
 * `dist.integrity`, and the `kition` field the Package workflow wrote), checked to be that kit's
 * editor package in `scope`, at `version` when one is asked for, with npm's integrity and every
 * build commit: `{ version, integrity, commits }`.
 */
export function editorMetadata(kit, metadata, { scope, version } = {}) {
  const name = uiPackageName(kit, scope)
  const problems = []
  if (metadata?.name !== name) problems.push(`name ${metadata?.name ?? 'missing'} instead of ${name}`)
  if (!VERSION.test(String(metadata?.version))) problems.push(`version ${metadata?.version ?? 'missing'} is not a version`)
  else if (version && metadata.version !== version) problems.push(`version ${metadata.version} instead of ${version}`)
  problems.push(...kitionProblems(kit, metadata, { role: 'ui' }))
  const commits = BUILD_COMMITS.filter((key) => !COMMIT.test(String(metadata?.kition?.build?.[key])))
  if (commits.length) problems.push(`kition.build has no valid ${commits.join(', ')}`)
  if (problems.length) throw new Error(`${kit}: the registry's ${name} differs (${problems.join(', ')})`)
  return { version: metadata.version, integrity: metadata.dist.integrity, commits: Object.fromEntries(BUILD_COMMITS.map((key) => [key, metadata.kition.build[key]])) }
}

/**
 * Checks the registry's metadata of `kit`'s headless package for `platform` in `scope` belongs to
 * the editor's build (`version`, `commit`); answers its integrity.
 */
export function headlessMetadata(kit, platform, metadata, { scope, version, commit }) {
  const name = headlessPackageName(kit, platform, scope)
  const problems = []
  if (metadata?.name !== name) problems.push(`name ${metadata?.name ?? 'missing'} instead of ${name}`)
  if (metadata?.version !== version) problems.push(`version ${metadata?.version ?? 'missing'} instead of ${version}`)
  problems.push(...kitionProblems(kit, metadata, { role: 'headless', platform }))
  if (metadata?.kition?.build?.commit !== commit) problems.push(`kition.build.commit ${metadata?.kition?.build?.commit ?? 'missing'} instead of the editor's ${commit}`)
  if (problems.length) throw new Error(`${kit}: the registry's ${name} differs (${problems.join(', ')})`)
  return metadata.dist.integrity
}

/**
 * The metadata of `name` at `version` from the first registry of `list` that has it, or null when
 * every registry answers that it has no such version (HTTP 404). Throws when a registry fails and
 * none has it, so a registry that cannot be reached never passes for one without the package.
 */
async function optionalVersion(list, name, version, fetchImpl) {
  let absent = 0
  try {
    return (
      await firstRegistry(list, `${name}@${version}`, async (registry) => {
        const found = await registryVersion(registry, name, version, fetchImpl)
        if (found) return found
        absent += 1
        throw new Error('no such version (HTTP 404)')
      })
    ).value
  } catch (error) {
    if (absent === list.length) return null
    throw error
  }
}

/**
 * The npm pin of `kit` at `version` (or the registry's `latest` of its editor package when no
 * version is given) in `scope` (default `KITION_NPM_SCOPE`, else @kition): the editor package's
 * metadata and the headless package of every platform npm has at that version, each tarball
 * downloaded from the first registry of `list` that serves it with the integrity npm names, to
 * record its size. Answers `{ registry, entry, missing }`: the registry of the editor's metadata,
 * the lock entry, and the platforms no registry has.
 */
export async function pinKit(kit, version, list, { scope = npmScope(), fetchImpl = globalThis.fetch } = {}) {
  checkScope(scope)
  const name = uiPackageName(kit, scope)
  const { registry, value: metadata } = await firstRegistry(list, `${name}@${version ?? 'latest'}`, async (at) => {
    const found = await registryVersion(at, name, version ?? 'latest', fetchImpl)
    if (!found) throw new Error('no such version (HTTP 404)')
    return found
  })
  const editor = editorMetadata(kit, metadata, { scope, version })
  const editorBytes = (await downloadTarball(list, name, editor.version, editor.integrity, fetchImpl)).value
  const platforms = {}
  const missing = []
  for (const platform of PLATFORMS) {
    const platformName = headlessPackageName(kit, platform, scope)
    const found = await optionalVersion(list, platformName, editor.version, fetchImpl)
    if (!found) {
      missing.push(platform)
      continue
    }
    const integrity = headlessMetadata(kit, platform, found, { scope, version: editor.version, commit: editor.commits.commit })
    platforms[platform] = tarballPin((await downloadTarball(list, platformName, editor.version, integrity, fetchImpl)).value)
  }
  const entry = { scope, version: editor.version, ...editor.commits, editor: tarballPin(editorBytes), platforms }
  const problem = lockEntryProblem(kit, entry)
  if (problem) throw new Error(problem)
  return { registry, entry, missing }
}

/**
 * Writes the lock file `file` (made when missing) with `entries` replacing or adding kits: the
 * lock's comment first, kits sorted.
 */
export function writeKitLockFile(file, entries) {
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const { $comment: _comment, ...kits } = { ...current, ...entries }
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
 * the published package: scripts/fetch-kits.mjs writes what it fetched by, scripts/build-kit-ui.sh
 * marks a local build (`"local": true`), and kition-sdk's tools/kit-npm-package.mjs leaves it out
 * of the npm package.
 */
export const KIT_PACKAGE_STAMP = '.kition-package.json'

/**
 * The stamp a fetched package gets: of an npm pin, the scope, version, the editor's integrity and
 * the build commits; of a Release pin, its repository, version, asset, SHA-256 and build commits.
 */
export function publishedKitPackageStamp(pinned) {
  if (lockForm(pinned) === 'release') return Object.fromEntries(['repository', 'version', 'asset', 'sha256', ...BUILD_COMMITS].map((key) => [key, pinned[key]]))
  return { scope: pinned.scope, version: pinned.version, integrity: pinned.editor?.integrity, ...Object.fromEntries(BUILD_COMMITS.map((key) => [key, pinned[key]])) }
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
    return `${kit}: a local build (scripts/build-kit-ui.sh, kit ${stamp.kitCommit ?? 'unknown commit'}), not the published ${pinnedPackage(kit, pinned)}`
  }
  const expected = publishedKitPackageStamp(pinned)
  const differences = [...new Set([...Object.keys(expected), ...Object.keys(stamp)])].filter((key) => stamp[key] !== expected[key])
  if (differences.length) {
    return `${kit}: differs from the lock (${differences.map((key) => `${key} ${stamp[key] ?? 'missing'} instead of ${expected[key] ?? 'none'}`).join(', ')})`
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

/** Extracts the .tgz `tarball` into a new scratch folder and answers it; the caller removes it. */
function extract(tarball, kit) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kition-kit-${kit}-`))
  fs.writeFileSync(path.join(scratch, 'package.tgz'), tarball)
  // By its bare name, in its own folder: GNU tar reads a drive letter in a path as a remote host.
  execFileSync('tar', ['-xzf', 'package.tgz'], { cwd: scratch, stdio: ['ignore', 'ignore', 'inherit'] })
  fs.rmSync(path.join(scratch, 'package.tgz'))
  return scratch
}

/**
 * Replaces `kitsDir/<kit>-ui` with `from`, stamps it, and checks it against the lock. `from`'s
 * `kit-ui.json` is checked first, so a package of another kit, version or commit leaves the folder
 * as it was.
 */
function installKitPackage(from, kitsDir, kit, pinned) {
  const unpacked = kitPackageProblem(path.dirname(from), kit, pinned, { stamp: false })
  if (unpacked) throw new Error(unpacked)
  const target = path.join(kitsDir, `${kit}-ui`)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(kitsDir, { recursive: true })
  fs.cpSync(from, target, { recursive: true })
  writeKitPackageStamp(kitsDir, kit, publishedKitPackageStamp(pinned))
  const problem = kitPackageProblem(kitsDir, kit, pinned)
  if (problem) throw new Error(problem)
}

/**
 * Unpacks the editor package `tarball` of the pinned `kit` into `kitsDir/<kit>-ui`, replacing what
 * is there, stamps it, and checks it against the lock. An npm pin's tarball holds `package/package.json`
 * and `package/<kit>-ui/` and nothing else, and its package.json must be the pinned package, version
 * and build commits; a Release pin's asset holds `<kit>-ui/` and nothing else.
 */
export function unpackKitPackage(tarball, kitsDir, kit, pinned) {
  const scratch = extract(tarball, kit)
  const folder = `${kit}-ui`
  try {
    if (lockForm(pinned) === 'release') {
      const inside = fs.readdirSync(scratch).sort()
      if (inside.join(',') !== folder) throw new Error(`${pinned.asset} holds ${inside.join(', ') || 'nothing'}, not ${folder}/`)
      installKitPackage(path.join(scratch, folder), kitsDir, kit, pinned)
      return
    }
    const name = uiPackageName(kit, pinned.scope)
    const top = path.join(scratch, 'package')
    const inside = fs.existsSync(top) ? fs.readdirSync(top).sort() : []
    if (inside.join(',') !== ['package.json', folder].sort().join(',')) throw new Error(`${name}@${pinned.version} holds ${inside.join(', ') || 'nothing'} under package/, not package.json and ${folder}/`)
    const manifest = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'))
    const build = manifest.kition?.build ?? {}
    const differences = [
      manifest.name !== name && `name ${manifest.name}`,
      manifest.version !== pinned.version && `version ${manifest.version}`,
      ...BUILD_COMMITS.filter((key) => build[key] !== pinned[key]).map((key) => `kition.build.${key} ${build[key] ?? 'missing'}`),
    ].filter(Boolean)
    if (differences.length) throw new Error(`${name}@${pinned.version}: its package.json differs from the lock (${differences.join(', ')})`)
    installKitPackage(path.join(top, folder), kitsDir, kit, pinned)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** The address of a Release pin's asset: `https://github.com/<repository>/releases/download/<tag>/<asset>`. */
export const releaseAssetUrl = (pinned) => `https://github.com/${pinned.repository}/releases/download/${pinned.tag}/${pinned.asset}`

/** The Release pin's asset, checked against its size and SHA-256. The kit repositories are public: no token. */
async function downloadReleaseAsset(pinned, fetchImpl) {
  const response = await fetchImpl(releaseAssetUrl(pinned))
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${releaseAssetUrl(pinned)}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== pinned.size || sha256 !== pinned.sha256) {
    throw new Error(`${pinned.asset}: ${bytes.length} bytes, sha256 ${sha256}; the lock pins ${pinned.size} bytes, sha256 ${pinned.sha256}`)
  }
  return bytes
}

/** An npm tarball of `name` from the first registry of `list` with `tarball`'s integrity, of its size. */
async function downloadPinnedTarball(list, name, version, tarball, fetchImpl) {
  const { registry, value } = await downloadTarball(list, name, version, tarball.integrity, fetchImpl)
  if (value.length !== tarball.size) throw new Error(`${name}@${version}: ${value.length} bytes; the lock pins ${tarball.size}`)
  return { registry, bytes: value }
}

/**
 * Downloads the pinned editor package of `kit` and unpacks it into `kitsDir/<kit>-ui`: an npm pin
 * from the first registry of `list` that serves it with the pinned integrity (and size), a Release
 * pin from GitHub (its size and SHA-256). Answers where it came from.
 */
export async function fetchKitPackage(kit, pinned, kitsDir, list, fetchImpl = globalThis.fetch) {
  if (lockForm(pinned) === 'release') {
    unpackKitPackage(await downloadReleaseAsset(pinned, fetchImpl), kitsDir, kit, pinned)
    return releaseAssetUrl(pinned)
  }
  const { registry, bytes } = await downloadPinnedTarball(list, uiPackageName(kit, pinned.scope), pinned.version, pinned.editor, fetchImpl)
  unpackKitPackage(bytes, kitsDir, kit, pinned)
  return registry
}

/**
 * Downloads the headless package of every platform an npm pin of `kit` pins, each checked against
 * its integrity and size and against its package.json (the package, version, platform and the
 * pin's commit), and unpacks each into `dir/<kit>-<platform>/` (kit.json and `kition-<kit>`, `.exe`
 * on Windows). Answers `{ <platform>: registry }`. A Release pin has no platform packages.
 */
export async function fetchHeadlessPackages(kit, pinned, dir, list, fetchImpl = globalThis.fetch) {
  if (lockForm(pinned) === 'release') throw new Error(`${kit}: a Release pin has no headless packages; pin it on npm with node scripts/pin-kits.mjs ${kit}`)
  const fetched = {}
  for (const [platform, tarball] of Object.entries(pinned.platforms)) {
    const name = headlessPackageName(kit, platform, pinned.scope)
    const { registry, bytes } = await downloadPinnedTarball(list, name, pinned.version, tarball, fetchImpl)
    const scratch = extract(bytes, kit)
    try {
      const top = path.join(scratch, 'package')
      const manifest = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'))
      const executable = `kition-${kit}${platform.startsWith('win32') ? '.exe' : ''}`
      const differences = [
        manifest.name !== name && `name ${manifest.name}`,
        manifest.version !== pinned.version && `version ${manifest.version}`,
        manifest.kition?.platform !== platform && `kition.platform ${manifest.kition?.platform ?? 'missing'}`,
        manifest.kition?.build?.commit !== pinned.commit && `kition.build.commit ${manifest.kition?.build?.commit ?? 'missing'}`,
        !fs.existsSync(path.join(top, 'kit.json')) && 'no kit.json',
        !fs.existsSync(path.join(top, executable)) && `no ${executable}`,
      ].filter(Boolean)
      if (differences.length) throw new Error(`${name}@${pinned.version}: differs from the lock (${differences.join(', ')})`)
      const target = path.join(dir, `${kit}-${platform}`)
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      fs.cpSync(top, target, { recursive: true })
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
    fetched[platform] = registry
  }
  return fetched
}
