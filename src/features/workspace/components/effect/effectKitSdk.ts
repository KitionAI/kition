import type { KitEngineInfo, KitSdkManifest } from '@/features/kits/public'

/** The Effect engine (`kition-effect-sdk` in the kition-effect repository), built by `scripts/build-kit-sdk.sh effect`. */
export const EFFECT_SDK: KitSdkManifest = {
  kitId: 'kit.effect',
  dir: 'effect-sdk',
  module: 'kition_effect_sdk',
  documentClass: 'EffectDocument',
}

/** One animated property of a layer and its key times, in composition seconds. */
type EffectAnimated = { path: string; name: string; times: number[] }

/** One layer of the composition, top first. */
type EffectLayer = {
  id: number
  index: number
  name: string
  type: string
  /** In and out points, composition seconds. */
  in: number
  out: number
  selected: boolean
  animated: EffectAnimated[]
}

/** One transform property of the selected layer at the current time. */
export type EffectProperty = { path: string; name: string; type: 'scalar' | 'vec2' | 'vec3' | string; value: number | number[]; animated: boolean }

/** What the Effect editor shows about the open project. */
export type EffectState = {
  comp: { id: number; name: string; width: number; height: number; fps: number; duration: number } | null
  time: number
  /** One frame, in seconds. */
  frame: number
  layers: EffectLayer[]
  /** The first selected layer's transform, for the properties panel. */
  transform: { layer: number; properties: EffectProperty[] } | null
}

type Inspected = {
  comp?: { id?: number; name?: string; width?: number; height?: number; frameRate?: number; duration?: number } | null
  info?: {
    layers?: Array<{ id?: number; index?: number; name?: string; type?: string; in?: number; out?: number; selected?: boolean; animated?: EffectAnimated[] }>
    transform?: { layer?: number; properties?: EffectProperty[] }
  } | null
  time?: number
}

/** Reads the active composition, its layers, and the current time from the engine's inspect JSON. */
export function describeEffect(info: KitEngineInfo): EffectState {
  const inspected = info.inspected as Inspected
  const comp = inspected.comp
  const fps = comp?.frameRate || 30
  return {
    comp: comp ? { id: comp.id ?? 0, name: comp.name ?? '', width: comp.width ?? info.width, height: comp.height ?? info.height, fps, duration: comp.duration ?? 0 } : null,
    time: inspected.time ?? 0,
    frame: 1 / fps,
    layers: (inspected.info?.layers ?? []).map((layer) => ({
      id: layer.id ?? 0,
      index: layer.index ?? 0,
      name: layer.name ?? '',
      type: layer.type ?? '',
      in: layer.in ?? 0,
      out: layer.out ?? 0,
      selected: layer.selected === true,
      animated: layer.animated ?? [],
    })),
    transform: inspected.info?.transform?.layer != null ? { layer: inspected.info.transform.layer, properties: inspected.info.transform.properties ?? [] } : null,
  }
}

/** `seconds` as `0:00:01:12` at `fps` frames per second. */
export function effectTimecode(seconds: number, fps: number) {
  const rate = Math.max(1, Math.round(fps))
  const frames = Math.max(0, Math.round(seconds * fps))
  const pad = (value: number) => String(value).padStart(2, '0')
  const total = Math.floor(frames / rate)
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frames % rate)}`
}
