import type { KitsPhotoDetails } from '@/api/kits'
import type { KitEngineInfo, KitSdkManifest, RasterRect } from '@/features/kits/public'

/** The Photo engine (`kition-photo-sdk` in the kit-photo repository), built by `scripts/build-kit-sdk.sh photo`. */
export const PHOTO_SDK: KitSdkManifest = {
  kitId: 'kit.photo',
  dir: 'photo-sdk',
  module: 'kition_photo_sdk',
  documentClass: 'PhotoDocument',
}

type InspectedLayer = {
  id?: number
  name?: string
  kind?: string
  visible?: boolean
  opacity?: number
  blend?: string
  selected?: boolean
  bounds?: [number, number, number, number] | null
  children?: InspectedLayer[]
}

/** What the Photo editor shows about the open image. */
export type PhotoState = {
  details: KitsPhotoDetails
  summary: string
  /** The active layer's content bounds, for the Move tool. */
  activeBounds: RasterRect | null
  hasSelection: boolean
}

function findLayer(layers: readonly InspectedLayer[] | undefined, id: number | null | undefined): InspectedLayer | null {
  for (const layer of layers ?? []) {
    if (layer.id === id) return layer
    const inner = findLayer(layer.children, id)
    if (inner) return inner
  }
  return null
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

function boundsOf(layer: InspectedLayer | null): RasterRect | null {
  const bounds = layer?.bounds
  if (!bounds || bounds[2] <= 0 || bounds[3] <= 0) return null
  return { x0: bounds[0], y0: bounds[1], x1: bounds[0] + bounds[2], y1: bounds[1] + bounds[3] }
}

/** Reads the image's size, mode, and layers from the engine's inspect JSON. */
export function describePhoto(info: KitEngineInfo): PhotoState {
  const inspected = info.inspected as { mode?: string; depth?: number; activeLayer?: number | null; layers?: InspectedLayer[]; hasSelection?: boolean }
  const layers: KitsPhotoDetails['layers'] = []
  flattenLayers(inspected.layers, 0, layers)
  const mode = inspected.mode ?? ''
  const depth = inspected.depth ?? 8
  return {
    details: { width: info.width, height: info.height, mode, depth, layers, activeLayer: inspected.activeLayer ?? null },
    summary: `${info.width} x ${info.height} px, ${mode}, ${depth}-bit, ${layers.length} layers`,
    activeBounds: boundsOf(findLayer(inspected.layers, inspected.activeLayer)),
    hasSelection: inspected.hasSelection === true,
  }
}
