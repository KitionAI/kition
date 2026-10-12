import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { FilmClip, FilmState } from './filmKitSdk'

const HEADER_WIDTH = 104
const RULER_HEIGHT = 24
const TRACK_HEIGHT = 34
const MIN_SECONDS = 10
const DRAG_THRESHOLD = 3

/** Clip colours by the engine's label names; anything else is the product purple. */
const LABEL_COLORS: Record<string, string> = {
  Violet: '#7c6cf0',
  Iris: '#6f7cf2',
  Caribbean: '#2bb3a3',
  Lavender: '#a78bfa',
  Cerulean: '#3b9fe0',
  Forest: '#4f9d69',
  Rose: '#e2789a',
  Mango: '#f0a53c',
  Purple: '#8b5cf6',
  Blue: '#3b82f6',
  Teal: '#14b8a6',
  Magenta: '#d946ef',
  Tan: '#c8a27a',
  Green: '#22c55e',
  Brown: '#a16207',
  Yellow: '#eab308',
}

type FilmTimelineProps = {
  film: FilmState
  onSeek: (seconds: number) => void
  onSelect: (clip: number, add: boolean) => void
  /** A clip dragged along its track to start at `seconds`. */
  onMove: (clip: FilmClip, track: number, seconds: number) => void
}

function rulerStep(pixelsPerSecond: number) {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (step * pixelsPerSecond >= 64) return step
  }
  return 600
}

function clock(seconds: number) {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * The sequence's tracks and clips, drawn by Kition from the engine's
 * inspect data: click or drag the ruler to move the playhead, click a clip
 * to select it (Shift adds), drag a clip along its track to move it.
 */
export function FilmTimeline({ film, onSeek, onSelect, onMove }: FilmTimelineProps) {
  const { t } = useTranslation('workspace')
  const area = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [drag, setDrag] = useState<{ clip: FilmClip; track: number; from: number; dx: number } | null>(null)

  useEffect(() => {
    const element = area.current
    if (!element) return undefined
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const span = Math.max(MIN_SECONDS, film.duration * 1.1)
  const pps = Math.max(1, (width - HEADER_WIDTH - 16) / span)
  const step = rulerStep(pps)
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, index) => index * step)
  const secondsAt = (clientX: number) => {
    const rect = area.current?.getBoundingClientRect()
    return Math.max(0, ((clientX - (rect?.left ?? 0)) - HEADER_WIDTH) / pps)
  }

  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    onSeek(secondsAt(event.clientX))
  }

  const startClip = (event: ReactPointerEvent<HTMLButtonElement>, clip: FilmClip, track: number) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ clip, track, from: event.clientX, dx: 0 })
  }

  const endClip = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag
    setDrag(null)
    if (!current) return
    if (Math.abs(current.dx) < DRAG_THRESHOLD) onSelect(current.clip.id, event.shiftKey)
    else onMove(current.clip, current.track, Math.max(0, current.clip.start + current.dx / pps))
  }

  return (
    <div ref={area} className="relative shrink-0 select-none border-t border-border bg-background text-xs" data-testid="film-timeline">
      <div
        className="relative cursor-ew-resize border-b border-border bg-secondary/40"
        style={{ height: RULER_HEIGHT, paddingLeft: HEADER_WIDTH }}
        onPointerDown={scrub}
        onPointerMove={(event) => {
          if (event.buttons === 1) onSeek(secondsAt(event.clientX))
        }}
        data-testid="film-ruler"
      >
        {ticks.map((second) => (
          <span key={second} className="absolute top-1 -translate-x-1/2 tabular-nums text-muted-foreground" style={{ left: HEADER_WIDTH + second * pps }}>
            {clock(second)}
          </span>
        ))}
      </div>
      {film.tracks.map((track) => (
        <div key={`${track.kind}-${track.id}`} className="relative flex border-b border-border/70" style={{ height: TRACK_HEIGHT }} onPointerDown={scrub} data-testid={`film-track-${track.name}`}>
          <div className="flex shrink-0 items-center border-r border-border px-2 text-muted-foreground" style={{ width: HEADER_WIDTH }}>
            <span className="truncate">{track.name}</span>
          </div>
          {track.clips.map((clip) => {
            const dx = drag?.clip.id === clip.id ? drag.dx : 0
            return (
              <button
                key={clip.id}
                type="button"
                className={cn(
                  'absolute top-1 bottom-1 overflow-hidden rounded-md px-1.5 text-left text-[11px] font-medium text-white shadow-sm outline-none',
                  clip.selected && 'ring-2 ring-foreground ring-offset-1',
                  track.kind === 'audio' && 'opacity-80',
                )}
                style={{ left: HEADER_WIDTH + clip.start * pps + dx, width: Math.max(4, clip.duration * pps), background: LABEL_COLORS[clip.label] ?? '#5645d4' }}
                title={clip.name}
                aria-pressed={clip.selected}
                onPointerDown={(event) => startClip(event, clip, track.id)}
                onPointerMove={(event) => {
                  if (drag?.clip.id === clip.id) setDrag({ ...drag, dx: event.clientX - drag.from })
                }}
                onPointerUp={endClip}
                data-testid={`film-clip-${clip.id}`}
              >
                <span className="block truncate leading-[26px]">{clip.name}</span>
              </button>
            )
          })}
        </div>
      ))}
      {film.tracks.length ? null : <p className="px-3 py-4 text-muted-foreground">{t('filmKit.noSequence')}</p>}
      <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary" style={{ left: HEADER_WIDTH + film.playhead * pps }} data-testid="film-playhead">
        <span className="absolute -left-1 top-0 size-2.5 rotate-45 rounded-[2px] bg-primary" />
      </div>
    </div>
  )
}
