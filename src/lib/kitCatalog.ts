/**
 * The kits of this build, as their manifests declare them. Kition names no kit in its code: which
 * kits ship is configuration (`kits/kits.lock.json`), and everything about one kit (its id and
 * name, the files it edits and views, what it creates, its engine) is read from the `kit.json` in
 * its package (`public/kits/<name>-ui/`). The catalog is loaded once, before the app renders
 * (`loadKitCatalog` in `src/main.tsx`), and read synchronously after that.
 *
 * A kit whose package is not in this build (a development build without it) is not in the
 * catalog: its files are files Kition knows nothing about.
 */
import shipped from '../../kits/kits.lock.json'

/** The part of a kit's manifest (`kit.json`) the catalog reads. */
export type KitManifest = {
  id: string
  name: string
  engine: { module: string; class: string }
  formats: readonly { id: string; extensions: readonly string[]; mime?: string; role?: 'edit' | 'view' }[]
  creates?: readonly KitCreate[]
  agent?: { prefix?: string; describe?: { noun?: string } }
  outline?: { command?: string }
}

/** What a kit creates (`kit.json` `creates[]`): an empty document of `size`, named `<baseName>.<extension>`. */
export type KitCreate = { id: string; extension: string; baseName: string; size: { width: number; height: number } }

/** One kit of this build. */
export type KitCatalogEntry = {
  /** `kit.json` `id`, for example `kit.note`. */
  id: string
  /** The id without `kit.`: the kit's package is `public/kits/<name>-ui/`, its icon `kit-icons/<name>.svg`. */
  name: string
  /** `kit.json` `name`, as people read it. */
  title: string
  /** The kit's package: its editor, shown in a frame. */
  embedded: { kitId: string; dir: string }
  /** The kit's engine inside its package; Kition makes new files with it. */
  engine: { kitId: string; dir: string; module: string; documentClass: string }
  /** Lowercase extensions, without the dot, it opens and saves in place. */
  edits: readonly string[]
  /** Lowercase extensions it opens read-only and does not also edit. */
  views: readonly string[]
  creates: readonly KitCreate[]
  /** The files it edits are text (every edit format's `mime` is `text/...`), so they can be read as they are. */
  text: boolean
  /** The agent's tools for the kit are `<prefix>_inspect`, `<prefix>_commands`, `<prefix>_run` (`agent.prefix`); none without one. */
  agentPrefix: string | null
  /** What one of its files is, for example `layered image` (`agent.describe.noun`); the kit's name without one. */
  noun: string
  /** Its documents have an outline (`outline.command`, platform K24): parts the workspace tree lists under a file. */
  outline: boolean
}

const KIT_ID_PREFIX = 'kit.'

let catalog: readonly KitCatalogEntry[] = []
let editors = new Map<string, KitCatalogEntry>()
let viewers = new Map<string, KitCatalogEntry>()

/** The names of the kits this build ships, from `kits/kits.lock.json`. */
function shippedKitNames(): string[] {
  return Object.keys(shipped).filter((name) => /^[a-z][a-z0-9-]*$/.test(name))
}

function extensionsOf(manifest: KitManifest, role: 'edit' | 'view') {
  const found = manifest.formats.filter((format) => (format.role ?? 'edit') === role).flatMap((format) => format.extensions)
  return [...new Set(found.map((extension) => extension.replace(/^\./, '').toLowerCase()))]
}

/** A manifest as a catalog entry; null when it is not a kit manifest the catalog can use. */
function kitCatalogEntry(manifest: KitManifest): KitCatalogEntry | null {
  if (!manifest?.id?.startsWith(KIT_ID_PREFIX) || !manifest.engine?.module || !manifest.engine.class || !Array.isArray(manifest.formats)) return null
  const name = manifest.id.slice(KIT_ID_PREFIX.length)
  const dir = `${name}-ui`
  const edits = extensionsOf(manifest, 'edit')
  const editable = manifest.formats.filter((format) => (format.role ?? 'edit') === 'edit')
  return {
    id: manifest.id,
    name,
    title: manifest.name || name,
    embedded: { kitId: manifest.id, dir },
    engine: { kitId: manifest.id, dir: `${dir}/engine`, module: manifest.engine.module, documentClass: manifest.engine.class },
    edits,
    views: extensionsOf(manifest, 'view').filter((extension) => !edits.includes(extension)),
    creates: manifest.creates ?? [],
    text: editable.length > 0 && editable.every((format) => format.mime?.startsWith('text/')),
    agentPrefix: manifest.agent?.prefix || null,
    noun: manifest.agent?.describe?.noun || manifest.name || name,
    outline: Boolean(manifest.outline?.command),
  }
}

/** Makes `manifests` the catalog. The first kit that declares an extension gets it. */
export function installKitCatalog(manifests: readonly KitManifest[]) {
  catalog = manifests.map(kitCatalogEntry).filter((entry): entry is KitCatalogEntry => entry !== null)
  editors = new Map()
  viewers = new Map()
  for (const entry of catalog) {
    for (const extension of entry.edits) if (!editors.has(extension)) editors.set(extension, entry)
    for (const extension of entry.views) if (!viewers.has(extension)) viewers.set(extension, entry)
  }
}

async function fetchManifest(name: string): Promise<KitManifest | null> {
  try {
    // A missing package cannot fake its manifest: the dev server answers unknown paths with the app's page.
    const response = await fetch(`/kits/${name}-ui/kit.json`, { cache: 'no-store' })
    if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? '')) return null
    const manifest = (await response.json()) as KitManifest
    return manifest.id === `${KIT_ID_PREFIX}${name}` ? manifest : null
  } catch {
    return null
  }
}

let loading: Promise<void> | null = null

/** Reads the manifest of every shipped kit whose package is in this build. Resolves when the catalog is ready. */
export function loadKitCatalog() {
  loading ??= Promise.all(shippedKitNames().map(fetchManifest)).then((manifests) => {
    installKitCatalog(manifests.filter((manifest): manifest is KitManifest => manifest !== null))
  })
  return loading
}

/** Every kit of this build, in the order the build lists them. */
export function kitCatalog() {
  return catalog
}

export function kitById(id: string) {
  return catalog.find((entry) => entry.id === id)
}

export function kitByName(name: string) {
  return catalog.find((entry) => entry.name === name)
}

function normalized(extension: string) {
  return extension.replace(/^\./, '').toLowerCase()
}

/** The kit that edits files of `extension` (with or without the dot). */
export function kitEditingExtension(extension: string) {
  return editors.get(normalized(extension))
}

/** The kit that opens files of `extension` read-only, when no kit edits them. */
export function kitViewingExtension(extension: string) {
  const key = normalized(extension)
  return editors.has(key) ? undefined : viewers.get(key)
}

/** Every extension a kit edits or views, lowercase, without the dot. */
export function kitExtensions(): string[] {
  return [...new Set([...editors.keys(), ...viewers.keys()])]
}
