/**
 * The Kit SDK contract: how a kit's engine, compiled to WebAssembly, plugs
 * into Kition's in-page editors. Every kit SDK exposes the same document
 * class shape (see docs/kit-sdk.md), so one worker, one client, and one
 * document hook serve every kit.
 */
import type { KitsCommandView } from '@/api/kits'

/** Where a kit's SDK lives in the app: `public/kits/<dir>/<module>.js` and `<module>_bg.wasm`. */
export type KitSdkManifest = {
  /** The kit id, for example `kit.photo`. */
  kitId: string
  /** Folder under `public/kits/`. */
  dir: string
  /** The wasm-pack module name, for example `kition_photo_sdk`. */
  module: string
  /** The exported document class, for example `PhotoDocument`. */
  documentClass: string
}

/** One open document, as every kit SDK exposes it to JavaScript. */
export interface KitSdkDocument {
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
  /** The document as file bytes; it stays unsaved until `markSaved`. */
  save(name?: string): Uint8Array
  /** Records that the bytes from the last `save` reached the file. */
  markSaved(): void
  free(): void
}

type KitSdkModule = {
  default: (input?: { module_or_path?: string | URL }) => Promise<unknown>
} & Record<string, { open(name: string, bytes: Uint8Array): KitSdkDocument } | unknown>

function sdkURL(manifest: KitSdkManifest, file: string) {
  return new URL(`/kits/${manifest.dir}/${file}`, globalThis.location.href)
}

const loading = new Map<string, Promise<KitSdkModule>>()

/** Loads and starts a kit's SDK once per page or worker. */
export function loadKitSdk(manifest: KitSdkManifest): Promise<KitSdkModule> {
  let module = loading.get(manifest.kitId)
  if (!module) {
    module = (async () => {
      // A full URL, so the dev server serves the file as it is instead of as an app module.
      const loaded = (await import(/* @vite-ignore */ sdkURL(manifest, `${manifest.module}.js`).href)) as KitSdkModule
      await loaded.default({ module_or_path: sdkURL(manifest, `${manifest.module}_bg.wasm`) })
      return loaded
    })()
    loading.set(manifest.kitId, module)
    module.catch(() => loading.delete(manifest.kitId))
  }
  return module
}

/** Opens file bytes with a loaded SDK's document class. */
export function openKitSdkDocument(module: KitSdkModule, manifest: KitSdkManifest, name: string, bytes: Uint8Array) {
  const documentClass = module[manifest.documentClass] as { open?: (name: string, bytes: Uint8Array) => KitSdkDocument } | undefined
  if (typeof documentClass?.open !== 'function') throw new Error(`${manifest.module} has no ${manifest.documentClass}.open`)
  return documentClass.open(name, bytes)
}

/** Whether a kit's SDK is built into this app (a missing file falls back to the app page). */
export async function kitSdkAvailable(manifest: KitSdkManifest) {
  try {
    const response = await fetch(sdkURL(manifest, `${manifest.module}.js`), { method: 'HEAD' })
    return response.ok && /javascript/i.test(response.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

/** A kit's commands, shaped like the runtime's kit command list so the same menus show them. */
export function kitSdkCommands(json: string): KitsCommandView[] {
  const commands = JSON.parse(json) as Array<{ id: string; title: string; menu: string[] | null; shortcut: string | null; mutates: boolean; enabled: boolean; description?: string | null }>
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    description: command.description ?? null,
    group: command.id.split('.')[0] ?? '',
    mutates: command.mutates,
    enabled: command.enabled,
    menu: command.menu ?? [],
    shortcut: command.shortcut,
  }))
}
