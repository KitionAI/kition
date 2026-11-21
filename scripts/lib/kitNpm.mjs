// Kit packages on npm (docs/kits.md, section 4b): their names, their addresses on a registry, npm's
// integrity, and reading them from the registries in order. The contract is kition-sdk's
// tools/kit-npm.mjs, which writes the packages for each kit repository's Package workflow
// (.github/workflows/kit-package.yml). In the npm scope `KITION_NPM_SCOPE` names (default
// @kition; see `npmScope`), named by the scope's layout (see `LEGACY_LAYOUT_SCOPES`):
//
//   legacy layout (@kition)        layout 1 (any other scope)
//   <scope>/kit-<kit>-<platform>   <scope>/<kit>-<platform>   kit.json and the headless executable
//                                                             kition-<kit> (.exe on Windows) at the
//                                                             package's top
//   <scope>/kit-<kit>-ui           <scope>/<kit>              the folder <kit>-ui/: the kit's package
//                                                             (editor, engine, fonts), which Kition
//                                                             ships in public/kits
//
// Each package.json has a `kition` field: { kit, id, name, version, role, platform (headless),
// protocol, extensions, views, build: { commit, sdkCommit?, tesseraCommit?, fontsCommit? } }.
// A version is published once and never replaced; its integrity is npm's `dist.integrity`
// (`sha512-<base64>` of the .tgz), checked whatever registry the bytes come from.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The variable naming the npm scope of the kit packages (kition-sdk tools/kit-npm.mjs). */
const SCOPE_VARIABLE = 'KITION_NPM_SCOPE'
/** The scope when `KITION_NPM_SCOPE` is not set (or empty). */
const DEFAULT_SCOPE = '@kition'
const SCOPE_FORM = /^@[a-z0-9][a-z0-9-]*$/

// The scopes whose packages keep the legacy names (kit-<kit>-ui, kit-<kit>-<platform>); every
// other scope uses layout 1 (<kit>, <kit>-<platform>). On cutover day, when @kition moves to
// layout 1: empty this list, then delete the legacy branches of uiPackageName and
// headlessPackageName below. The same list is in kition-sdk's tools/kit-npm.mjs and
// crates/kition-cli/src/registry.rs (LEGACY_LAYOUT_SCOPES).
export const LEGACY_LAYOUT_SCOPES = ['@kition']
/** Whether `scope` names its packages by the legacy layout. */
const isLegacyLayout = (scope) => LEGACY_LAYOUT_SCOPES.includes(scope)

/**
 * Names that are no kit's in layout 1, where a kit's packages are `<scope>/<kit>` and
 * `<scope>/<kit>-<platform>`: a kit of one of these names would be the scope's other packages
 * (`<scope>/cli`, `<scope>/kits`, `<scope>/kit-editor`, ...). kition-sdk's tools/kit-npm.mjs
 * `NOT_KIT_NAMES`.
 */
const NOT_KIT_NAMES = ['cli', 'convergence', 'embed', 'extensions', 'gateway', 'kdm', 'kit', 'kition', 'kits', 'script', 'sdk', 'sync', 'tessera']

/** `scope`, when it is an npm scope (`@`, then lowercase letters, digits and dashes); else throws, naming `what`. */
function checkScope(scope, what = 'the scope') {
  if (typeof scope !== 'string' || !SCOPE_FORM.test(scope)) throw new Error(`${what} is ${JSON.stringify(scope)}, not an npm scope (@ then lowercase letters, digits and dashes, such as @kition)`)
  return scope
}

/** The npm scope of `env`: `KITION_NPM_SCOPE`, else (unset or empty) `@kition`; one of another form throws. */
export function npmScope(env = process.env) {
  const value = env[SCOPE_VARIABLE]
  return value === undefined || value === '' ? DEFAULT_SCOPE : checkScope(value, SCOPE_VARIABLE)
}

/** The registries read after the ones configured, in this order (kition-sdk tools/kit-npm.mjs). */
export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

const KIT_NAME = /^[a-z][a-z0-9]*$/
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
export const COMMIT = /^[0-9a-f]{40}$/
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/

export function checkKitName(kit) {
  if (!KIT_NAME.test(String(kit))) throw new Error(`${JSON.stringify(kit)} is not a kit name`)
}

/** Checks `kit` is a kit's name in `scope`: in layout 1, none of `NOT_KIT_NAMES`. */
function checkKitNameIn(kit, scope) {
  checkKitName(kit)
  checkScope(scope)
  if (!isLegacyLayout(scope) && NOT_KIT_NAMES.includes(kit)) throw new Error(`${kit} is not a kit name in ${scope}: ${scope}/${kit} is another package there`)
}

/** The package of `kit`'s editor in `scope`: `@kition/kit-<kit>-ui`; in layout 1 `<scope>/<kit>`. */
export function uiPackageName(kit, scope = npmScope()) {
  checkKitNameIn(kit, scope)
  return isLegacyLayout(scope) ? `${scope}/kit-${kit}-ui` : `${scope}/${kit}`
}

/** The package of `kit`'s headless executable for `platform` in `scope`: `@kition/kit-<kit>-<platform>`; in layout 1 `<scope>/<kit>-<platform>`. */
export function headlessPackageName(kit, platform, scope = npmScope()) {
  checkKitNameIn(kit, scope)
  return isLegacyLayout(scope) ? `${scope}/kit-${kit}-${platform}` : `${scope}/${kit}-${platform}`
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
 * `<scope>:registry` (`npmScope(env)`, default @kition) from `npmrcText` (the user's ~/.npmrc); then `npm_config_registry`, else the
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
  add(npmrc[`${npmScope(env)}:registry`])
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
