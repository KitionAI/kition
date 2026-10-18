// Copied from kition-sdk packages/extensions/src/manifest.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `extension.json` (`KitExtensions 1.0`): what an extension is, which documents it applies to,
 * what it adds, and what it may do. Everything here is checked before any of its code runs.
 */

export const KIT_EXTENSIONS_CAPABILITY = 'KitExtensions 1.0'

/** The manifest version this host reads. */
export const MANIFEST_VERSION = '1.0'

/**
 * - `model.read`: read the document (`load`, `describe`, the command catalogue).
 * - `model.write`: change it (every write operation; a mutating command also needs it).
 * - `commands.run`: run the kit's commands.
 * - `network:<origin>`: reach that origin (`fetch`, WebSocket, …); nothing else is reachable.
 */
export type Permission = 'model.read' | 'model.write' | 'commands.run' | `network:${string}`

export type ExtensionCommand = { id: string; title: string; description?: string }

/** A panel the extension draws (in the kit UI's extension slot); hosts may not show panels yet. */
export type ExtensionPanel = { id: string; title: string; entry: string }

export type ExtensionActivation = {
  /** The kits the extension applies to (`kit.slide`, …). */
  kits: string[]
  /** File extensions (no dot) that narrow `kits`; every file of those kits when absent. */
  formats?: string[]
  /** `open`: activate when a matching document opens; `command` (default): on its first command. */
  on?: 'open' | 'command'
}

export type ExtensionManifest = {
  kitExtensions: typeof MANIFEST_VERSION
  /** Reverse domain name, lower case: `com.example.title-case`. */
  id: string
  name: string
  /** Semantic version. */
  version: string
  description?: string
  publisher?: string
  /** The ES module, relative to the package: one self-contained file (no relative imports). */
  entry: string
  activation: ExtensionActivation
  contributes: { commands: ExtensionCommand[]; panels?: ExtensionPanel[] }
  permissions: Permission[]
}

/** A manifest this host refuses, with every problem found. */
export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid extension.json: ${problems.join('; ')}`)
    this.name = 'ManifestError'
  }
}

const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const COMMAND_ID = /^[a-zA-Z][\w-]*(\.[\w-]+)+$/
const KIT_ID = /^kit\.[a-z0-9][a-z0-9-]*$/
const FORMAT = /^[a-z0-9]+$/
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const ENTRY = /^[\w-]+(\/[\w.-]+)*\.(mjs|js)$/
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const LOOPBACK = new Set(['localhost', '127.0.0.1'])
const KNOWN_PERMISSIONS = new Set(['model.read', 'model.write', 'commands.run'])

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max

/**
 * The origins a `network:` permission names, as CSP sources: `network:api.example.com` is
 * `https://api.example.com` and `wss://api.example.com`; a scheme may be given (`https`, `wss`,
 * or `http`/`ws` for loopback only), and a port. Answers `null` when it is not one.
 */
export function networkSources(permission: string): string[] | null {
  if (!permission.startsWith('network:')) return null
  const value = permission.slice('network:'.length)
  const match = /^(?:(https|wss|http|ws):\/\/)?([^/:]+)(?::(\d{1,5}))?\/?$/.exec(value)
  if (!match) return null
  const [, scheme, host, port] = match
  if (!HOST.test(host) || (port && Number(port) > 65535)) return null
  if ((scheme === 'http' || scheme === 'ws') && !LOOPBACK.has(host)) return null
  const suffix = port ? `:${port}` : ''
  return scheme ? [`${scheme}://${host}${suffix}`] : [`https://${host}${suffix}`, `wss://${host}${suffix}`]
}

/** The CSP `connect-src` value for `permissions`: their declared origins, or `'none'`. */
export function connectSources(permissions: readonly string[]): string {
  const sources = permissions.flatMap((permission) => networkSources(permission) ?? [])
  return sources.length ? [...new Set(sources)].join(' ') : "'none'"
}

export const hasPermission = (permissions: readonly string[], permission: Permission) => permissions.includes(permission)

/** Reads and checks an `extension.json` (text or parsed); throws `ManifestError` with every problem. */
export function parseManifest(input: unknown): ExtensionManifest {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (error) {
      throw new ManifestError([`not JSON: ${error instanceof Error ? error.message : String(error)}`])
    }
  }
  const problems: string[] = []
  if (!isObject(value)) throw new ManifestError(['the manifest is not an object'])
  const m = value
  if (m.kitExtensions !== MANIFEST_VERSION) problems.push(`kitExtensions must be "${MANIFEST_VERSION}"`)
  if (typeof m.id !== 'string' || !ID.test(m.id) || m.id.length > 100) problems.push('id must be a lower-case reverse domain name, such as com.example.title-case')
  if (!isText(m.name, 80)) problems.push('name is required (at most 80 characters)')
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) problems.push('version must be a semantic version, such as 1.0.0')
  if (m.description !== undefined && !isText(m.description, 500)) problems.push('description must be text (at most 500 characters)')
  if (m.publisher !== undefined && !isText(m.publisher, 100)) problems.push('publisher must be text (at most 100 characters)')
  if (typeof m.entry !== 'string' || !ENTRY.test(m.entry) || m.entry.split('/').some((part) => part === '..' || part === '.')) {
    problems.push('entry must be a .mjs or .js file inside the package, such as extension.mjs')
  }

  const activation = m.activation
  if (!isObject(activation)) problems.push('activation is required')
  else {
    if (!Array.isArray(activation.kits) || !activation.kits.length || !activation.kits.every((kit) => typeof kit === 'string' && KIT_ID.test(kit))) {
      problems.push('activation.kits must list kit ids, such as kit.slide')
    }
    if (activation.formats !== undefined && (!Array.isArray(activation.formats) || !activation.formats.every((format) => typeof format === 'string' && FORMAT.test(format)))) {
      problems.push('activation.formats must list lower-case file extensions without a dot')
    }
    if (activation.on !== undefined && activation.on !== 'open' && activation.on !== 'command') problems.push('activation.on must be "open" or "command"')
  }

  const contributes = m.contributes
  if (!isObject(contributes) || !Array.isArray(contributes.commands)) problems.push('contributes.commands is required (it may be empty)')
  else {
    const seen = new Set<string>()
    for (const command of contributes.commands as unknown[]) {
      if (!isObject(command) || typeof command.id !== 'string' || !COMMAND_ID.test(command.id)) {
        problems.push('each contributed command needs a namespaced id, such as titleCase.apply')
        continue
      }
      if (seen.has(command.id)) problems.push(`command ${command.id} is contributed twice`)
      seen.add(command.id)
      if (!isText(command.title, 80)) problems.push(`command ${command.id} needs a title (at most 80 characters)`)
      if (command.description !== undefined && !isText(command.description, 300)) problems.push(`command ${command.id} has an invalid description`)
    }
    if (contributes.panels !== undefined) {
      if (!Array.isArray(contributes.panels)) problems.push('contributes.panels must be a list')
      else
        for (const panel of contributes.panels as unknown[]) {
          if (!isObject(panel) || typeof panel.id !== 'string' || !COMMAND_ID.test(panel.id) || !isText(panel.title, 80) || typeof panel.entry !== 'string' || !/^[\w-]+(\/[\w.-]+)*\.html$/.test(panel.entry)) {
            problems.push('each panel needs a namespaced id, a title, and an .html entry inside the package')
          }
        }
    }
  }

  if (!Array.isArray(m.permissions)) problems.push('permissions is required (it may be empty)')
  else {
    for (const permission of m.permissions as unknown[]) {
      if (typeof permission !== 'string') problems.push('permissions must be strings')
      else if (permission.startsWith('network:')) {
        if (!networkSources(permission)) problems.push(`${permission} is not an origin (network:api.example.com, network:https://api.example.com:8443)`)
      } else if (!KNOWN_PERMISSIONS.has(permission)) problems.push(`unknown permission ${permission}`)
    }
    if (m.permissions.includes('model.write') && !m.permissions.includes('model.read')) problems.push('model.write needs model.read')
  }

  if (problems.length) throw new ManifestError(problems)
  return value as ExtensionManifest
}

/** The file extension of `path`, lower case, without the dot. */
const formatOf = (path: string) => {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Whether `manifest` applies to a document of `kitId` at `path`. */
export function appliesTo(manifest: ExtensionManifest, document: { kitId: string; path?: string }): boolean {
  if (!manifest.activation.kits.includes(document.kitId)) return false
  const formats = manifest.activation.formats
  if (!formats?.length || document.path === undefined) return true
  return formats.includes(formatOf(document.path))
}
