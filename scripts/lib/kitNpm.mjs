// Kit packages on npm (docs/kits.md, section 4b): their names, their addresses on a registry, npm's
// integrity, and reading them from the registries in order. The contract is kition-sdk's
// tools/kit-npm.mjs, which writes the packages for each kit repository's Package workflow
// (.github/workflows/kit-package.yml):
//
//   @kition/kit-<kit>-<platform>@<version>   kit.json and the headless executable kition-<kit>
//                                            (.exe on Windows) at the package's top
//   @kition/kit-<kit>-ui@<version>           the folder <kit>-ui/: the kit's package (editor,
//                                            engine, fonts), which Kition ships in public/kits
//
// Each package.json has a `kition` field: { kit, id, name, version, role, platform (headless),
// protocol, extensions, views, build: { commit, sdkCommit?, tesseraCommit?, fontsCommit? } }.
// A version is published once and never replaced; its integrity is npm's `dist.integrity`
// (`sha512-<base64>` of the .tgz), checked whatever registry the bytes come from.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCOPE = '@kition'
/** The registries read after the ones configured, in this order (kition-sdk tools/kit-npm.mjs). */
export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

const KIT_NAME = /^[a-z][a-z0-9]*$/
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
export const COMMIT = /^[0-9a-f]{40}$/
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/

export function checkKitName(kit) {
  if (!KIT_NAME.test(String(kit))) throw new Error(`${JSON.stringify(kit)} is not a kit name`)
}

/** The package of `kit`'s editor: `@kition/kit-<kit>-ui`. */
export function uiPackageName(kit) {
  checkKitName(kit)
  return `${SCOPE}/kit-${kit}-ui`
}

/** The package of `kit`'s headless executable for `platform`: `@kition/kit-<kit>-<platform>`. */
export function headlessPackageName(kit, platform) {
  checkKitName(kit)
  return `${SCOPE}/kit-${kit}-${platform}`
}

const withSlash = (registry) => (registry.endsWith('/') ? registry : `${registry}/`)

/** A version's metadata (or a dist-tag's, `latest`) on `registry`: `<registry>@kition%2f<name>/<version>`. */
export function metadataUrl(registry, name, version) {
  return `${withSlash(registry)}${name.replace('/', '%2f')}/${encodeURIComponent(version)}`
}

/** A version's tarball on `registry`, by npm's convention: `<registry>@kition/<name>/-/<name>-<version>.tgz`. */
export function tarballUrl(registry, name, version) {
  return `${withSlash(registry)}${name}/-/${name.split('/').pop()}-${version}.tgz`
}

/** npm's integrity of `bytes`: `sha512-<base64>`. */
export const integrityOf = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

/** The `key=value` settings of an .npmrc text: comments and blank lines skipped, `${VAR}` expanded. */
export function parseNpmrc(text, env = process.env) {
  const settings = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    settings[key] = value.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '')
  }
  return settings
}

/**
 * The registries to read, in order, as kition-sdk's tools/kit-npm.mjs `registries()` and the
 * kition CLI read them: `KITION_NPM_REGISTRY` (one address or several separated by commas); then
 * `@kition:registry` from `npmrcText` (the user's ~/.npmrc); then `npm_config_registry`, else the
 * .npmrc `registry`; then npmjs.org and npmmirror.com. Each address ends with `/`; none twice.
 */
export function registries(env = process.env, npmrcText = '') {
  const list = []
  const add = (value) => {
    const address = String(value ?? '').trim()
    if (!/^https?:\/\//i.test(address)) return
    const normal = withSlash(address)
    if (!list.includes(normal)) list.push(normal)
  }
  for (const value of String(env.KITION_NPM_REGISTRY ?? '').split(',')) add(value)
  const npmrc = parseNpmrc(npmrcText, env)
  add(npmrc[`${SCOPE}:registry`])
  add(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? npmrc.registry)
  for (const address of DEFAULT_REGISTRIES) add(address)
  return list
}

/** `registries` with this machine's settings: the environment and the user's ~/.npmrc. */
export function configuredRegistries(env = process.env) {
  let npmrc = ''
  try {
    npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8')
  } catch {
    // No ~/.npmrc: the environment and the defaults.
  }
  return registries(env, npmrc)
}

/**
 * Tries `attempt(registry)` on each registry in order and answers the first result; a registry
 * that fails (no answer, an HTTP error, wrong bytes) is skipped for the next. Throws, naming every
 * registry's failure, when none succeeds.
 */
export async function firstRegistry(list, what, attempt) {
  if (!list.length) throw new Error(`no registry to read ${what} from`)
  const failures = []
  for (const registry of list) {
    try {
      return { registry, value: await attempt(registry) }
    } catch (error) {
      failures.push(`${registry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`${what}: no registry has it\n  ${failures.join('\n  ')}`)
}

/**
 * The metadata of `name` at `version` (or a dist-tag such as `latest`) on one registry: the JSON
 * with `name`, `version`, `dist.integrity`, `kition`. Answers null when the registry answers that
 * it has no such version (HTTP 404); throws on any other failure.
 */
export async function registryVersion(registry, name, version, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(metadataUrl(registry, name, version), { headers: { accept: 'application/json' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${name}@${version}`)
  const found = await response.json()
  if (found?.name !== name) throw new Error(`asked for ${name}@${version}, answered ${found?.name}@${found?.version}`)
  if (version !== 'latest' && found.version !== version) throw new Error(`asked for ${name}@${version}, answered ${found.version}`)
  return found
}

/** The metadata of `name` at `version` from the first of `list` that has it. */
export async function readVersion(list, name, version, fetchImpl = globalThis.fetch) {
  return firstRegistry(list, `${name}@${version}`, async (registry) => {
    const found = await registryVersion(registry, name, version, fetchImpl)
    if (!found) throw new Error('no such version (HTTP 404)')
    return found
  })
}

/**
 * The tarball of `name` at `version` from the first of `list` that serves it with `integrity`: a
 * registry whose bytes have another integrity is skipped, like one that does not answer.
 */
export async function downloadTarball(list, name, version, integrity, fetchImpl = globalThis.fetch) {
  if (!INTEGRITY.test(String(integrity))) throw new Error(`${name}@${version}: ${integrity} is not an npm integrity (sha512-<base64>)`)
  return firstRegistry(list, `${name}@${version}`, async (registry) => {
    const response = await fetchImpl(tarballUrl(registry, name, version))
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${tarballUrl(registry, name, version)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const got = integrityOf(bytes)
    if (got !== integrity) throw new Error(`its tarball's integrity is ${got}, not ${integrity}`)
    return bytes
  })
}
