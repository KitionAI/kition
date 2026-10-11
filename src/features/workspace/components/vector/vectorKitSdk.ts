import type { KitEngineInfo, KitSdkManifest } from '@/features/kits/public'

/** The Vector engine (`kition-vector-sdk` in the kit-vector repository), built by `scripts/build-kit-sdk.sh vector`. */
export const VECTOR_SDK: KitSdkManifest = {
  kitId: 'kit.vector',
  dir: 'vector-sdk',
  module: 'kition_vector_sdk',
  documentClass: 'VectorDocument',
}

/** One row of the Layers panel: a layer or an object in it. */
export type VectorLayer = {
  id: number
  name: string
  kind: string
  visible: boolean
  locked: boolean
  /** The layer's selection colour, as `#rrggbb`. */
  color: string | null
  children: VectorLayer[]
}

/** What the Vector editor shows about the open drawing. */
export type VectorState = {
  layers: VectorLayer[]
  selection: number[]
  /** The selection's bounds in points, when something is selected. */
  selectionBounds: { x: number; y: number; width: number; height: number } | null
  artboards: number
  /** Top-level objects in the layers (a group counts once). */
  objects: number
  units: string
}

type InspectedNode = { id?: number; name?: string; kind?: string; visible?: boolean; locked?: boolean; color?: string; children?: InspectedNode[] }

function layerOf(node: InspectedNode): VectorLayer {
  return {
    id: node.id ?? -1,
    name: node.name ?? '',
    kind: node.kind ?? '',
    visible: node.visible !== false,
    locked: node.locked === true,
    color: typeof node.color === 'string' ? node.color : null,
    children: (node.children ?? []).map(layerOf),
  }
}

function countObjects(nodes: readonly VectorLayer[]): number {
  return nodes.reduce((total, node) => total + (node.kind === 'Layer' ? countObjects(node.children) : 1), 0)
}

/** The drawing from the engine's `inspect()`: layers, selection, artboards. */
export function describeVector(info: KitEngineInfo): VectorState {
  const inspected = info.inspected as {
    layers?: InspectedNode[]
    selection?: number[]
    selectionBounds?: VectorState['selectionBounds']
    artboards?: unknown[]
    units?: string
  }
  const layers = (inspected.layers ?? []).map(layerOf)
  return {
    layers,
    selection: inspected.selection ?? [],
    selectionBounds: inspected.selectionBounds ?? null,
    artboards: inspected.artboards?.length ?? 0,
    objects: countObjects(layers),
    units: inspected.units ?? 'Points',
  }
}
