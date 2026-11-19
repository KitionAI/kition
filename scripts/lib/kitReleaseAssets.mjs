// The assets of a kit's `package-v<version>` Release (docs/kits.md, section 4b), written by the
// kit repository's Package workflow (.github/workflows/kit-package.yml):
//
//   kition-<kit>-<version>.tgz                    the kit's package (scripts/package-kit.sh)
//   kition-<kit>-<version>.json                   its entry for kits/kits.lock.json
//   kition-<kit>-<version>-<platform>.tar.gz      kit.json and the headless executable
//                                                 `kition-<kit>` (.exe on Windows) at its top, as
//                                                 `kition kit install` unpacks it (kition-sdk's
//                                                 tools/release-archives.mjs packs the same way)
//   kits-index-<kit>-<version>.json               a kit index (kition-sdk's
//                                                 schemas/kits-index.schema.json) holding this kit
//                                                 version only, with each platform's archive at its
//                                                 address in this Release
//
// An asset is published once and never replaced. A run on a version whose Release exists adds
// only the assets it does not have yet. Everything here is pure or works on local files; the
// workflow does the GitHub calls.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The platforms a kit's headless executable is built for, exactly as kition-sdk's release workflow
 * builds the published kits' executables (.github/workflows/release.yml, job `executables`): the
 * runner, the Rust target, and on Linux the glibc floor the executable is linked against with
 * cargo-zigbuild.
 */
export const HEADLESS_PLATFORMS = [
  { platform: 'darwin-arm64', target: 'aarch64-apple-darwin', runner: 'macos-15' },
  { platform: 'darwin-x64', target: 'x86_64-apple-darwin', runner: 'macos-15-intel' },
  { platform: 'linux-arm64', target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-24.04-arm', glibc: '2.17' },
  { platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', glibc: '2.17' },
  { platform: 'win32-x64', target: 'x86_64-pc-windows-msvc', runner: 'windows-2025' },
]
const PLATFORM_NAMES = HEADLESS_PLATFORMS.map(({ platform }) => platform)

const KIT_NAME = /^[a-z][a-z0-9]*$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

function checkKitVersion(kit, version) {
  if (!KIT_NAME.test(kit)) throw new Error(`${JSON.stringify(kit)} is not a kit name`)
  if (!VERSION.test(version)) throw new Error(`${JSON.stringify(version)} is not a kit version`)
}

const releaseTag = (version) => `package-v${version}`
const packageAssets = (kit, version) => [`kition-${kit}-${version}.tgz`, `kition-${kit}-${version}.json`]
export const headlessArchive = (kit, version, platform) => `kition-${kit}-${version}-${platform}.tar.gz`
export const indexFragment = (kit, version) => `kits-index-${kit}-${version}.json`
const executableOf = (kit, platform) => `kition-${kit}${platform.startsWith('win32') ? '.exe' : ''}`

/** The platform of a headless archive name of this kit version, or null when it is not one. */
export function archivePlatform(kit, version, name) {
  const prefix = `kition-${kit}-${version}-`
  if (!name.startsWith(prefix) || !name.endsWith('.tar.gz')) return null
  const platform = name.slice(prefix.length, -'.tar.gz'.length)
  return PLATFORM_NAMES.includes(platform) ? platform : null
}

/**
 * What a Package run has to publish, from the names of the assets the `package-v<version>` Release
 * has (`assets`), or `null` when there is no such Release yet:
 *
 * - `package`: `publish` when there is no Release (scripts/package-kit.sh creates it with the
 *   package and its lock entry), `published` when the Release has both. A Release with one of them,
 *   or with neither, is refused: its package is never replaced, and is not added afterwards.
 * - `platforms`: the platforms whose headless archive the Release does not have.
 * - `fragment`: `publish` when the Release has no index fragment, else `published`.
 */
export function releasePlan(kit, version, assets) {
  checkKitVersion(kit, version)
  const tag = releaseTag(version)
  const names = new Set(assets ?? [])
  let packageState = 'publish'
  if (assets) {
    const present = packageAssets(kit, version).filter((name) => names.has(name))
    if (present.length !== 2) {
      const missing = packageAssets(kit, version).filter((name) => !names.has(name))
      throw new Error(`the ${tag} Release has no ${missing.join(' and ')}; a published Release's package is never replaced or added afterwards, so bump version in the kit's kit.json`)
    }
    packageState = 'published'
  }
  return {
    tag,
    package: packageState,
    platforms: PLATFORM_NAMES.filter((platform) => !names.has(headlessArchive(kit, version, platform))),
    fragment: names.has(indexFragment(kit, version)) ? 'published' : 'publish',
  }
}

/** The build matrix (`include`) for these platforms, in HEADLESS_PLATFORMS order. */
export function headlessMatrix(platforms) {
  const unknown = platforms.filter((platform) => !PLATFORM_NAMES.includes(platform))
  if (unknown.length) throw new Error(`no platform ${unknown.join(', ')} (${PLATFORM_NAMES.join(', ')})`)
  return HEADLESS_PLATFORMS.filter(({ platform }) => platforms.includes(platform))
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Checks one platform's build folder, as the workflow lays it out: the kit's `kit.json`, its
 * executable `kition-<kit>` (.exe on Windows), and the `handshakes.json` kition-sdk's
 * `tools/kit-handshake.mjs --record` wrote after starting it on that platform. The executable must
 * be the file the handshake was recorded for and must have answered `kit.initialize` with the
 * kit.json's id and version, speaking the protocol its kit.json names (the same checks as
 * kition-sdk's tools/release-archives.mjs `platformKits`).
 */
function checkHeadlessBuild(kit, platform, dir) {
  if (!PLATFORM_NAMES.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORM_NAMES.join(', ')})`)
  const kitJsonFile = path.join(dir, 'kit.json')
  if (!fs.existsSync(kitJsonFile)) throw new Error(`${dir} has no kit.json`)
  const kitJson = readJson(kitJsonFile)
  checkKitVersion(kit, kitJson.version)
  if (kitJson.id !== `kit.${kit}`) throw new Error(`${kitJsonFile}: its id is ${kitJson.id}, not kit.${kit}`)
  const name = `kition-${kit}`
  if (kitJson.headless?.executable !== name) throw new Error(`${kitJsonFile}: headless.executable is ${kitJson.headless?.executable}, not ${name}`)
  const file = executableOf(kit, platform)
  const executable = path.join(dir, file)
  if (!fs.existsSync(executable)) throw new Error(`${dir} has no ${file}`)
  const handshakesFile = path.join(dir, 'handshakes.json')
  if (!fs.existsSync(handshakesFile)) throw new Error(`${dir} has no handshakes.json: run kition-sdk's tools/kit-handshake.mjs --record there, on ${platform}`)
  const seen = readJson(handshakesFile)[file]
  if (!seen) throw new Error(`${handshakesFile} has no ${file}`)
  if (seen.sha256 !== sha256(executable)) throw new Error(`${executable} is not the file its handshake was recorded for`)
  if (seen.kit?.id !== kitJson.id || seen.kit?.version !== kitJson.version) {
    throw new Error(`${file} answers kit.initialize as ${seen.kit?.id} ${seen.kit?.version}; its kit.json is ${kitJson.id} ${kitJson.version}`)
  }
  const protocol = `kition-kit/${seen.protocolVersion}`
  if (kitJson.headless?.protocol !== protocol) throw new Error(`${file} speaks ${protocol}; its kit.json says ${kitJson.headless?.protocol}`)
  return { kitJson, kitJsonFile, executable, file, protocol }
}

/**
 * `<archive>` holding `files` (`{ name, from, mode }`) at its top, packed as kition-sdk's
 * tools/release-archives.mjs packs a kit archive: tar runs in a folder beside the archive and is
 * given relative names only (Git for Windows' GNU tar reads `D:\...` as a remote host), without
 * macOS's AppleDouble files.
 */
function writeArchive(archive, files) {
  const stage = fs.mkdtempSync(path.join(path.dirname(archive), '.stage-'))
  try {
    for (const { name, from, mode } of files) {
      fs.copyFileSync(from, path.join(stage, name))
      fs.chmodSync(path.join(stage, name), mode)
    }
    execFileSync('tar', ['-czf', `../${path.basename(archive)}`, ...files.map(({ name }) => name)], { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
  return { size: fs.statSync(archive).size, sha256: sha256(archive) }
}

/** Checks one platform's build folder and writes its archive in `out`; answers what it wrote. */
export function packHeadless(kit, platform, dir, out) {
  const { kitJson, kitJsonFile, executable, file, protocol } = checkHeadlessBuild(kit, platform, dir)
  fs.mkdirSync(out, { recursive: true })
  const archive = headlessArchive(kit, kitJson.version, platform)
  const written = writeArchive(path.join(out, archive), [
    { name: 'kit.json', from: kitJsonFile, mode: 0o644 },
    { name: file, from: executable, mode: 0o755 },
  ])
  return { kit, version: kitJson.version, platform, protocol, file: archive, ...written }
}

/** The extensions a kit edits (its `edit` formats), lowercase, without the dot. */
const editExtensions = (kitJson) => [...new Set((kitJson.formats ?? []).filter((format) => format.role === 'edit').flatMap((format) => format.extensions ?? []).map((ext) => ext.replace(/^\./, '').toLowerCase()))]

/**
 * The index fragment of one kit version: a kit index (schemaVersion 1) with this kit and version
 * only, and each archive (`{ platform, size, sha256 }`) at `${baseUrl}/<archive>`.
 */
export function buildFragment(kitJson, archives, baseUrl) {
  const kit = String(kitJson.id ?? '').replace(/^kit\./, '')
  checkKitVersion(kit, kitJson.version)
  if (!archives.length) throw new Error(`no headless archive of ${kit} ${kitJson.version}`)
  const platforms = {}
  for (const { platform, size, sha256: sum } of [...archives].sort((a, b) => a.platform.localeCompare(b.platform))) {
    if (!PLATFORM_NAMES.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORM_NAMES.join(', ')})`)
    if (platforms[platform]) throw new Error(`two archives for ${platform}`)
    platforms[platform] = { url: `${baseUrl.replace(/\/$/, '')}/${headlessArchive(kit, kitJson.version, platform)}`, size, sha256: sum }
  }
  const extensions = editExtensions(kitJson)
  if (!extensions.length) throw new Error(`${kitJson.id} edits no file type (no kit.json format with role edit and extensions)`)
  return {
    schemaVersion: 1,
    kits: {
      [kit]: {
        id: kitJson.id,
        name: kitJson.name,
        extensions,
        versions: { [kitJson.version]: { protocol: kitJson.headless?.protocol, platforms } },
      },
    },
  }
}

/** The kit.json at the top of a headless archive. */
function archiveKitJson(archive) {
  return JSON.parse(execFileSync('tar', ['-xzOf', path.basename(archive), 'kit.json'], { cwd: path.dirname(archive), encoding: 'utf8' }))
}

/**
 * The index fragment of the headless archives of `kit` `version` in `dir` (as published: the
 * fragment states their own size and SHA-256), with the kit.json they carry, which must be the same
 * in each.
 */
export function fragmentFromArchives(kit, version, dir, baseUrl) {
  checkKitVersion(kit, version)
  const found = fs
    .readdirSync(dir)
    .map((name) => ({ name, platform: archivePlatform(kit, version, name) }))
    .filter(({ platform }) => platform)
    .sort((a, b) => a.platform.localeCompare(b.platform))
  if (!found.length) throw new Error(`${dir} holds no headless archive of ${kit} ${version}`)
  let kitJson = null
  const archives = found.map(({ name, platform }) => {
    const file = path.join(dir, name)
    const carried = archiveKitJson(file)
    if (!kitJson) kitJson = carried
    else if (JSON.stringify(carried) !== JSON.stringify(kitJson)) throw new Error(`the kit.json in ${name} differs from the one in ${headlessArchive(kit, version, found[0].platform)}`)
    return { platform, size: fs.statSync(file).size, sha256: sha256(file) }
  })
  if (kitJson.id !== `kit.${kit}` || kitJson.version !== version) throw new Error(`the archives carry ${kitJson.id} ${kitJson.version}, not kit.${kit} ${version}`)
  return buildFragment(kitJson, archives, baseUrl)
}

/** The platforms a fragment lists for `kit` `version`. */
export function fragmentPlatforms(fragment, kit, version) {
  return Object.keys(fragment?.kits?.[kit]?.versions?.[version]?.platforms ?? {}).sort()
}

/**
 * What the publishing job does once the builds ran: which built archives (file names in `built`)
 * to upload, because the Release (`assets`) does not have them, which it has already (they stay as
 * published), and which of the platforms the run set out to build (`wanted`) produced no archive.
 */
export function publishPlan(kit, version, assets, built, wanted) {
  checkKitVersion(kit, version)
  const names = new Set(assets)
  const archives = built.filter((name) => archivePlatform(kit, version, name))
  const strays = built.filter((name) => !archivePlatform(kit, version, name))
  if (strays.length) throw new Error(`not headless archives of ${kit} ${version}: ${strays.join(', ')}`)
  const builtPlatforms = new Set(archives.map((name) => archivePlatform(kit, version, name)))
  return {
    upload: archives.filter((name) => !names.has(name)).sort(),
    kept: archives.filter((name) => names.has(name)).sort(),
    failed: headlessMatrix(wanted).map(({ platform }) => platform).filter((platform) => !builtPlatforms.has(platform)),
  }
}
