import type { KitsPhotoDetails } from '@/api/kits'
import type { KitEngineInfo, KitSdkManifest } from '@/features/kits/public'

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
  children?: InspectedLayer[]
}

/** What the Photo editor shows about the open image. */
export type PhotoState = {
  details: KitsPhotoDetails
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

/** Reads the image's size, mode, and layers from the engine's inspect JSON. */
export function describePhoto(info: KitEngineInfo): PhotoState {
  const inspected = info.inspected as { mode?: string; depth?: number; activeLayer?: number | null; layers?: InspectedLayer[] }
  const layers: KitsPhotoDetails['layers'] = []
  flattenLayers(inspected.layers, 0, layers)
  const mode = inspected.mode ?? ''
  const depth = inspected.depth ?? 8
  return {
    details: { width: info.width, height: info.height, mode, depth, layers, activeLayer: inspected.activeLayer ?? null },
    summary: `${info.width} x ${info.height} px, ${mode}, ${depth}-bit, ${layers.length} layers`,
  }
}
