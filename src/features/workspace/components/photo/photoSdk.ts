import type { KitsCommandView, KitsPhotoDetails } from '@/api/kits'

/**
 * The Photo engine compiled to WebAssembly (`kition-photo-sdk` in the
 * kit-photo repository). Kition loads it on first use and edits images in
 * the page: the engine renders pixels, Kition draws everything else.
 */

/** The engine's JavaScript interface; see `crates/kition-photo-sdk/src/lib.rs`. */
export interface PhotoSdkDocument {
  readonly width: number
  readonly height: number
  readonly revision: bigint
  readonly dirty: boolean
  /** RGBA8 of the area at (`x`, `y`) document pixels shown at `scale` screen pixels per pixel. */
  render(x: number, y: number, scale: number, width: number, height: number): Uint8Array
  /** RGBA8 of the image area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number): Uint8Array
  execute(command: string, params: string): string
  inspect(): string
  commands(): string
  /** The document as file bytes; it stays unsaved until `markSaved`. */
  save(name?: string): Uint8Array
  /** Records that the bytes from the last `save` reached the file. */
  markSaved(): void
  free(): void
}

interface PhotoSdkModule {
  default: (input?: { module_or_path?: string | URL }) => Promise<unknown>
  PhotoDocument: {
    open(name: string, bytes: Uint8Array): PhotoSdkDocument
    create(name: string, width: number, height: number): PhotoSdkDocument
  }
}

const SDK_URL = '/kits/photo-sdk/kition_photo_sdk.js'

let loading: Promise<PhotoSdkModule> | null = null

/** Loads and starts the engine once per page. */
export function loadPhotoSdk(): Promise<PhotoSdkModule> {
  if (!loading) {
    loading = (async () => {
      // A full URL, so the dev server serves the file as it is instead of as an app module.
      const module = (await import(/* @vite-ignore */ new URL(SDK_URL, window.location.href).href)) as PhotoSdkModule
      await module.default({ module_or_path: new URL('/kits/photo-sdk/kition_photo_sdk_bg.wasm', window.location.href) })
      return module
    })()
    loading.catch(() => {
      loading = null
    })
  }
  return loading
}

/** Whether the engine is installed in this build (a missing file falls back to the app page). */
export async function photoSdkAvailable() {
  try {
    const response = await fetch(SDK_URL, { method: 'HEAD' })
    return response.ok && /javascript/i.test(response.headers.get('content-type') ?? '')
  } catch {
    return false
  }
}

type InspectedLayer = {
  id?: number
  name?: string
  kind?: string
  visible?: boolean
  opacity?: number
  blend?: string
  selected?: boolean
  children?: InspectedLayer[]
}

type Inspected = {
  width: number
  height: number
  mode: string
  depth: number
  activeLayer: number | null
  canUndo: boolean
  canRedo: boolean
  layers: InspectedLayer[]
}

/** The engine's view of the open document. */
export type PhotoSdkState = {
  details: KitsPhotoDetails
  canUndo: boolean
  canRedo: boolean
  summary: string
}

function flattenLayers(layers: readonly InspectedLayer[] | undefined, depth: number, out: KitsPhotoDetails['layers']) {
  for (const layer of layers ?? []) {
    out.push({
      id: layer.id,
      name: layer.name ?? '',
      kind: layer.kind ?? '',
      visible: layer.visible ?? true,
      opacity: layer.opacity,
      blend: layer.blend,
      selected: layer.selected ?? false,
      depth,
    })
    flattenLayers(layer.children, depth + 1, out)
  }
}

/** Reads the document's size, layers, and history state from the engine. */
export function inspectPhotoDocument(doc: PhotoSdkDocument): PhotoSdkState {
  const inspected = JSON.parse(doc.inspect()) as Inspected
  const layers: KitsPhotoDetails['layers'] = []
  flattenLayers(inspected.layers, 0, layers)
  return {
    details: {
      width: inspected.width,
      height: inspected.height,
      mode: inspected.mode,
      depth: inspected.depth,
      layers,
      activeLayer: inspected.activeLayer,
    },
    canUndo: inspected.canUndo,
    canRedo: inspected.canRedo,
    summary: `${inspected.width} x ${inspected.height} px, ${inspected.mode}, ${inspected.depth}-bit, ${layers.length} layers`,
  }
}

/** The engine's commands, shaped like the kit command list so the same menus can show them. */
export function photoSdkCommands(doc: PhotoSdkDocument): KitsCommandView[] {
  const commands = JSON.parse(doc.commands()) as Array<{ id: string; title: string; menu: string[] | null; shortcut: string | null; mutates: boolean; enabled: boolean }>
  return commands.map((command) => ({
    id: command.id,
    title: command.title,
    description: null,
    group: command.id.split('.')[0] ?? '',
    mutates: command.mutates,
    enabled: command.enabled,
    menu: command.menu ?? [],
    shortcut: command.shortcut,
  }))
}
