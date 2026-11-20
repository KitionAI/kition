// What a kit repository's Package workflow (.github/workflows/kit-package.yml; docs/kits.md,
// section 4b) builds and publishes on npm for one kit version, and the checks of what it built.
// kition-sdk's tools/kit-npm-package.mjs writes, packs and compares the packages (kitNpm.mjs names
// them); this decides which to build, checks each headless build before it is packaged, and which
// packed tarballs to publish. Everything here is pure or reads local files, except
// `planFromRegistry`, which reads the registry's metadata through the `fetch` it is given.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { checkKitName, COMMIT, headlessPackageName, registryVersion, uiPackageName, VERSION } from './kitNpm.mjs'

/**
 * The platforms a kit's headless executable is built for, exactly as kition-sdk's release workflow
 * builds the published kits' executables (.github/workflows/release.yml, job `executables`): the
 * runner, the Rust target, and on Linux the glibc floor the executable is linked against with
 * cargo-zigbuild. The names are kition-sdk's platforms (packages/kition/src/platforms.json).
 */
export const HEADLESS_PLATFORMS = [
  { platform: 'darwin-arm64', target: 'aarch64-apple-darwin', runner: 'macos-15' },
  { platform: 'darwin-x64', target: 'x86_64-apple-darwin', runner: 'macos-15-intel' },
  { platform: 'linux-arm64', target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-24.04-arm', glibc: '2.17' },
  { platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-24.04', glibc: '2.17' },
  { platform: 'win32-x64', target: 'x86_64-pc-windows-msvc', runner: 'windows-2025' },
]
const PLATFORM_NAMES = HEADLESS_PLATFORMS.map(({ platform }) => platform)

function checkKitVersion(kit, version) {
  checkKitName(kit)
  if (!VERSION.test(String(version))) throw new Error(`${JSON.stringify(version)} is not a kit version`)
}

/** The build matrix (`include`) for these platforms, in HEADLESS_PLATFORMS order. */
export function headlessMatrix(platforms) {
  const unknown = platforms.filter((platform) => !PLATFORM_NAMES.includes(platform))
  if (unknown.length) throw new Error(`no platform ${unknown.join(', ')} (${PLATFORM_NAMES.join(', ')})`)
  return HEADLESS_PLATFORMS.filter(({ platform }) => platforms.includes(platform))
}

/**
 * What a Package run builds for `kit` `version` from the run's `commit`, given what the registry
 * lacks (`missing`, as kition-sdk's `kit-npm-package.mjs missing` prints it: `{ platforms, ui }`)
 * and the registry's metadata of the packages of that version it has (`published`): the editor
 * package when it is missing, and the headless package of each missing platform. Nothing is built
 * when nothing is missing. A version is one build: when the registry has some of its packages and
 * lacks others, the ones it has must have been built from `commit` (their `kition.build.commit`),
 * or the run stops before building anything.
 */
export function buildPlan({ kit, version, commit, missing, published = [] }) {
  checkKitVersion(kit, version)
  if (!COMMIT.test(String(commit))) throw new Error(`${JSON.stringify(commit)} is not a commit`)
  if (!Array.isArray(missing?.platforms) || typeof missing?.ui !== 'boolean') throw new Error('missing must be { platforms: [...], ui: true|false }')
  const matrix = headlessMatrix(missing.platforms)
  const platforms = matrix.map(({ platform }) => platform)
  const build = missing.ui || platforms.length > 0
  if (build) {
    const others = published
      .filter((metadata) => metadata?.kition?.build?.commit !== commit)
      .map((metadata) => `${metadata?.name}@${metadata?.version} (${metadata?.kition?.build?.commit ?? 'no build commit'})`)
    if (others.length) {
      throw new Error(
        `${kit} ${version} is published in part, from another commit than this run's ${commit}: ${others.join(', ')}. ` +
          'A version is one build: re-run the run that published them, or bump version in the kit\'s kit.json',
      )
    }
  }
  return { version, ui: missing.ui ? 'publish' : 'published', platforms, matrix, build }
}

/**
 * `buildPlan` with the metadata of the packages `missing` says `registry` has, read from it: every
 * platform's headless package and the editor package of `kit` `version`.
 */
export async function planFromRegistry({ kit, version, commit, missing, registry }, fetchImpl = globalThis.fetch) {
  checkKitVersion(kit, version)
  const present = [...PLATFORM_NAMES.filter((platform) => !missing.platforms.includes(platform)).map((platform) => headlessPackageName(kit, platform)), ...(missing.ui ? [] : [uiPackageName(kit)])]
  const published = []
  if (missing.ui || missing.platforms.length) {
    for (const name of present) {
      const found = await registryVersion(registry, name, version, fetchImpl)
      if (!found) throw new Error(`${registry} has no ${name}@${version}, although it was not listed as missing`)
      published.push(found)
    }
  }
  return buildPlan({ kit, version, commit, missing, published })
}

/** The plan as `key=value` lines for $GITHUB_OUTPUT. */
export function planOutput(plan) {
  return [`version=${plan.version}`, `ui=${plan.ui}`, `platforms=${JSON.stringify(plan.platforms)}`, `matrix=${JSON.stringify(plan.matrix)}`, `build=${plan.build}`].join('\n')
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Checks one platform's build folder, as the workflow lays it out: the kit's `kit.json`, its
 * executable `kition-<kit>` (.exe on Windows), and the `handshakes.json` kition-sdk's
 * `tools/kit-handshake.mjs --record` wrote after starting it on that platform. The executable must
 * be the file the handshake was recorded for and must have answered `kit.initialize` with the
 * kit.json's id and version, speaking the protocol its kit.json names. Answers what it checked.
 */
export function checkHeadlessBuild(kit, platform, dir) {
  if (!PLATFORM_NAMES.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORM_NAMES.join(', ')})`)
  const kitJsonFile = path.join(dir, 'kit.json')
  if (!fs.existsSync(kitJsonFile)) throw new Error(`${dir} has no kit.json`)
  const kitJson = readJson(kitJsonFile)
  checkKitVersion(kit, kitJson.version)
  if (kitJson.id !== `kit.${kit}`) throw new Error(`${kitJsonFile}: its id is ${kitJson.id}, not kit.${kit}`)
  const name = `kition-${kit}`
  if (kitJson.headless?.executable !== name) throw new Error(`${kitJsonFile}: headless.executable is ${kitJson.headless?.executable}, not ${name}`)
  const file = `${name}${platform.startsWith('win32') ? '.exe' : ''}`
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
  return { kit, version: kitJson.version, platform, protocol, file }
}

/**
 * What the publish job publishes once the builds ran: `packed` is what kition-sdk's
 * `kit-npm-package.mjs pack` printed for each package built (`{ file, name, version }`), `wanted`
 * the plan's `{ platforms, ui }`. Answers the tarballs to publish (headless packages in platform
 * order, then the editor package) and the wanted packages that built nothing. A tarball of another
 * kit, version or package, or two of one package, is refused.
 */
export function publishPlan({ kit, version, wanted, packed }) {
  checkKitVersion(kit, version)
  const wantedNames = [...headlessMatrix(wanted.platforms).map(({ platform }) => headlessPackageName(kit, platform)), ...(wanted.ui ? [uiPackageName(kit)] : [])]
  const byName = new Map()
  for (const entry of packed) {
    if (!wantedNames.includes(entry.name) || entry.version !== version) throw new Error(`${entry.file} is ${entry.name}@${entry.version}, which this run does not publish (${wantedNames.map((name) => `${name}@${version}`).join(', ') || 'nothing'})`)
    if (byName.has(entry.name)) throw new Error(`two tarballs of ${entry.name}@${version}: ${byName.get(entry.name).file} and ${entry.file}`)
    byName.set(entry.name, entry)
  }
  return {
    publish: wantedNames.filter((name) => byName.has(name)).map((name) => byName.get(name).file),
    failed: wantedNames.filter((name) => !byName.has(name)),
  }
}
