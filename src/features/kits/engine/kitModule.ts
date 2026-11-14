/**
 * The kit engine contract: how a kit's engine, compiled to WebAssembly, plugs
 * into Kition's in-page editors. Every kit module exposes the same document
 * class shape (see docs/kits.md), so one worker, one client, and one
 * document hook serve every kit. Nothing under `sdk/` imports the rest of
 * Kition: it is the portable core of the open Kition SDK.
 */

/** One engine command, as the editor's menus and shortcuts show it. */
export type KitCommand = {
  id: string
  title: string
  description: string | null
  /** The command's family, the id's first segment. */
  group: string
  mutates: boolean
  enabled: boolean
  /** The menu path, for example ["Layer", "New"]; empty when it is not in a menu. */
  menu: string[]
  /** As `Cmd+Shift+N`; `Cmd` is Control off macOS. */
  shortcut: string | null
  /** The parameters as a DeepSeek Harness `ParameterSchemaSpec`; commands with one can be agent tools. */
  schema?: Record<string, unknown> | null
  /** The engine's own parameter notes, as the agent reads them. */
  params?: string | null
}

/** The contract version this host implements (`contractVersion()` in the Rust crate). */
const KIT_CONTRACT_VERSION = 1

/** Where a kit's SDK lives in the app: `public/kits/<dir>/<module>.js` and `<module>_bg.wasm`. */
export type KitModuleManifest = {
  /** The kit id, for example `kit.photo`. */
  kitId: string
  /** Folder under `public/kits/`. */
  dir: string
  /** The wasm-pack module name, for example `kition_photo_sdk`. */
  module: string
  /** The exported document class, for example `PhotoDocument`. */
  documentClass: string
}

/** One open document, as every kit module exposes it to JavaScript. */
export interface KitModuleDocument {
  readonly width: number
  readonly height: number
  /** Moves with every change. */
  readonly revision: bigint
  readonly dirty: boolean
  /** RGBA8 of the area at (`x`, `y`) document pixels shown at `scale` screen pixels per pixel. */
  render(x: number, y: number, scale: number, width: number, height: number): Uint8Array
  /** RGBA8 of the document area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Uint8Array
  /** Runs an engine command with JSON parameters; returns its JSON result. */
  execute(command: string, params: string): string
  /** The document as JSON; it includes `canUndo` and `canRedo`. */
  inspect(): string
  /** Every command as JSON: id, title, menu path, shortcut, mutates, enabled. */
  commands(): string
  /** The ids of the commands that cannot run now, as JSON; optional in contract 1. */
  disabledCommands?(): string
  /** The document as file bytes; it stays unsaved until `markSaved`. */
  save(name?: string): Uint8Array
  /** Records that the bytes from the last `save` reached the file. */
  markSaved(): void
  free(): void
}

type KitModuleExports = {
  default: (input?: { module_or_path?: string | URL }) => Promise<unknown>
} & Record<string, { open(name: string, bytes: Uint8Array): KitModuleDocument } | unknown>

function sdkURL(manifest: KitModuleManifest, file: string) {
  return new URL(`/kits/${manifest.dir}/${file}`, globalThis.location.href)
}

const loading = new Map<string, Promise<KitModuleExports>>()

/** Loads and starts a kit's SDK once per page or worker. */
export function loadKitModule(manifest: KitModuleManifest): Promise<KitModuleExports> {
  let module = loading.get(manifest.kitId)
  if (!module) {
    module = (async () => {
      // A full URL, so the dev server serves the file as it is instead of as an app module.
      const loaded = (await import(/* @vite-ignore */ sdkURL(manifest, `${manifest.module}.js`).href)) as KitModuleExports
      await loaded.default({ module_or_path: sdkURL(manifest, `${manifest.module}_bg.wasm`) })
      return loaded
    })()
    loading.set(manifest.kitId, module)
    module.catch(() => loading.delete(manifest.kitId))
  }
  return module
}

/** A document's KDM replica to open it with: a snapshot (or a full change export) and its blobs. */
export type KitModuleReplica = { snapshot: Uint8Array; blobs: Uint8Array }

type KitModuleClass = {
  open?: (name: string, bytes: Uint8Array) => KitModuleDocument
  /** Opens a document as a stored replica (engine contract 2); empty `bytes`: the replica alone. */
  openWithReplica?: (name: string, bytes: Uint8Array, snapshot: Uint8Array, blobs: Uint8Array) => KitModuleDocument
  create?: (name: string, width: number, height: number) => KitModuleDocument
  contractVersion?: () => number
}

function documentClassOf(module: KitModuleExports, manifest: KitModuleManifest) {
  const documentClass = module[manifest.documentClass] as KitModuleClass | undefined
  if (typeof documentClass?.open !== 'function') throw new Error(`${manifest.module} has no ${manifest.documentClass}.open`)
  const version = documentClass.contractVersion?.() ?? 1
  if (version > KIT_CONTRACT_VERSION) throw new Error(`${manifest.module} needs kit engine contract ${version}; this app supports ${KIT_CONTRACT_VERSION}`)
  return documentClass
}

/**
 * Opens file bytes with a loaded SDK's document class; with `replica`, as that replica (a kit
 * without `openWithReplica` cannot, and fails).
 */
export function openKitModuleDocument(module: KitModuleExports, manifest: KitModuleManifest, name: string, bytes: Uint8Array, replica: KitModuleReplica | null = null) {
  const documentClass = documentClassOf(module, manifest)
  if (!replica) return documentClass.open!(name, bytes)
  if (typeof documentClass.openWithReplica !== 'function') throw new Error(`${manifest.module} cannot open a replica`)
  return documentClass.openWithReplica(name, bytes, replica.snapshot, replica.blobs)
}

/** A new, empty document of the SDK's own making (New image, New video project). */
export function createKitModuleDocument(module: KitModuleExports, manifest: KitModuleManifest, name: string, width: number, height: number) {
  const documentClass = documentClassOf(module, manifest)
  if (typeof documentClass.create !== 'function') throw new Error(`${manifest.module} cannot create documents`)
  return documentClass.create(name, width, height)
}

/** A kit's commands from its SDK's `commands()` JSON. */
export function kitModuleCommands(json: string): KitCommand[] {
  const commands = JSON.parse(json) as Array<{ id: string; title: string; menu: string[] | null; shortcut: string | null; mutates: boolean; enabled: boolean; description?: string | null; schema?: Record<string, unknown> | null; params?: string | null }>
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    description: command.description ?? null,
    group: command.id.split('.')[0] ?? '',
    mutates: command.mutates,
    enabled: command.enabled,
    menu: command.menu ?? [],
    shortcut: command.shortcut,
    schema: command.schema ?? null,
    params: command.params ?? null,
  }))
}
