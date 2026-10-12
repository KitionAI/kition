import type { KitEngineInfo, KitSdkManifest } from '@/features/kits/public'

/** The Film engine (`kition-film-sdk` in the kition-film repository), built by `scripts/build-kit-sdk.sh film`. */
export const FILM_SDK: KitSdkManifest = {
  kitId: 'kit.film',
  dir: 'film-sdk',
  module: 'kition_film_sdk',
  documentClass: 'FilmDocument',
}

/** One clip on a track, in seconds. */
export type FilmClip = { id: number; name: string; start: number; duration: number; label: string; selected: boolean }

type FilmTrack = { id: number; name: string; kind: 'video' | 'audio'; clips: FilmClip[] }

/** What the Film editor shows about the open project. */
export type FilmState = {
  name: string
  width: number
  height: number
  fps: number
  /** One frame, in seconds. */
  frame: number
  duration: number
  playhead: number
  tracks: FilmTrack[]
  selection: number[]
  summary: string
  /** The engine's time unit, for commands that take ticks. */
  ticksPerSecond: number
}

type InspectedTrack = { id?: number; name?: string; items?: Array<{ clip?: number; name?: string; start?: number; duration?: number; label?: string }> }

type Inspected = {
  project?: { name?: string }
  sequence?: {
    name?: string
    settings?: { width?: number; height?: number; frame_rate?: { num?: number; den?: number } }
    duration?: number
    video?: InspectedTrack[]
    audio?: InspectedTrack[]
    selection?: number[]
  } | null
  playhead?: number
  ticksPerSecond?: number
}

/** Reads the active sequence, its tracks and clips, and the playhead from the engine's inspect JSON. */
export function describeFilm(info: KitEngineInfo): FilmState {
  const inspected = info.inspected as Inspected
  const tps = inspected.ticksPerSecond || 254_016_000_000
  const sequence = inspected.sequence ?? null
  const rate = sequence?.settings?.frame_rate
  const fps = rate?.num && rate.den ? rate.num / rate.den : 30
  const selection = sequence?.selection ?? []
  const tracks = (kind: 'video' | 'audio', list: InspectedTrack[] | undefined): FilmTrack[] => (list ?? []).map((track) => ({
    id: track.id ?? 0,
    name: track.name ?? '',
    kind,
    clips: (track.items ?? []).map((item) => ({
      id: item.clip ?? 0,
      name: item.name ?? '',
      start: (item.start ?? 0) / tps,
      duration: (item.duration ?? 0) / tps,
      label: item.label ?? 'Violet',
      selected: selection.includes(item.clip ?? -1),
    })),
  }))
  const video = tracks('video', sequence?.video)
  const audio = tracks('audio', sequence?.audio)
  const fpsLabel = Number.isInteger(fps) ? String(fps) : fps.toFixed(3)
  return {
    name: sequence?.name ?? inspected.project?.name ?? '',
    width: info.width,
    height: info.height,
    fps,
    frame: 1 / fps,
    duration: (sequence?.duration ?? 0) / tps,
    playhead: (inspected.playhead ?? 0) / tps,
    // Video tracks stack upwards, as editors draw them: the top track first.
    tracks: [...video.reverse(), ...audio],
    selection,
    summary: `${info.width} x ${info.height} px, ${fpsLabel} fps, ${video.length} video and ${audio.length} audio tracks`,
    ticksPerSecond: tps,
  }
}

/** `hh:mm:ss:ff` for a time in seconds. */
export function timecode(seconds: number, fps: number) {
  const rounded = Math.max(0, Math.round(fps))
  const frames = Math.floor(Math.max(0, seconds) * fps + 1e-6)
  const ff = rounded ? frames % rounded : 0
  const total = rounded ? Math.floor(frames / rounded) : Math.floor(seconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`
}
