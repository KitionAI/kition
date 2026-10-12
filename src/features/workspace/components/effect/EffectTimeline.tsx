import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { EffectState } from './effectKitSdk'

const NAME_WIDTH = 200
const ROW_HEIGHT = 28

type EffectTimelineProps = {
  effect: EffectState
  onSeek: (seconds: number) => void
  onSelect: (layer: number, add: boolean) => void
}

/** Where a pointer is along the time area, in seconds within the composition. */
function timeAt(event: { clientX: number }, area: HTMLElement, duration: number) {
  const box = area.getBoundingClientRect()
  return Math.min(duration, Math.max(0, ((event.clientX - box.left) / Math.max(1, box.width)) * duration))
}

/**
 * The composition's layers over time, as in After Effects: one row per layer
 * with its bar from in to out point and its keyframes; the ruler scrubs the
 * current time, and a click on a row selects its layer.
 */
export function EffectTimeline({ effect, onSeek, onSelect }: EffectTimelineProps) {
  const { t } = useTranslation('workspace')
  const area = useRef<HTMLDivElement>(null)
  const duration = Math.max(effect.comp?.duration ?? 0, effect.frame)
  const percent = (seconds: number) => `${(Math.min(duration, Math.max(0, seconds)) / duration) * 100}%`
  const seconds = Math.floor(duration)
  const step = seconds > 30 ? 5 : seconds > 10 ? 2 : 1

  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!area.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    onSeek(timeAt(event, area.current, duration))
  }

  return (
    <div className="flex max-h-64 min-h-32 shrink-0 flex-col overflow-hidden border-t border-border bg-background text-[12px]" data-testid="effect-timeline">
      <div className="flex h-7 shrink-0 border-b border-border">
        <div className="flex shrink-0 items-center px-3 font-medium text-muted-foreground" style={{ width: NAME_WIDTH }}>{t('effectKit.layers')}</div>
        <div
          ref={area}
          className="relative flex-1 cursor-ew-resize select-none"
          onPointerDown={scrub}
          onPointerMove={(event) => {
            if (event.buttons && area.current) onSeek(timeAt(event, area.current, duration))
          }}
          data-testid="effect-ruler"
        >
          {Array.from({ length: Math.floor(seconds / step) + 1 }, (_, index) => index * step).map((mark) => (
            <span key={mark} className="absolute top-0 h-full border-l border-border pl-1 text-[10px] leading-7 text-muted-foreground" style={{ left: percent(mark) }}>
              {mark}s
            </span>
          ))}
          <span className="absolute top-0 z-10 h-full w-px bg-primary" style={{ left: percent(effect.time) }} aria-hidden="true" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {effect.layers.length ? effect.layers.map((layer) => (
          <div
            key={layer.id}
            className={cn('flex border-b border-border/60', layer.selected && 'bg-accent/60')}
            style={{ height: ROW_HEIGHT }}
            onClick={(event) => onSelect(layer.id, event.shiftKey || event.metaKey)}
            data-testid={`effect-layer-${layer.id}`}
          >
            <div className="flex shrink-0 items-center gap-2 truncate px-3 text-foreground" style={{ width: NAME_WIDTH }}>
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{layer.index}</span>
              <span className="truncate">{layer.name}</span>
            </div>
            <div className="relative flex-1">
              <div
                className={cn('absolute inset-y-1.5 rounded-md border', layer.selected ? 'border-primary/60 bg-primary/15' : 'border-border bg-muted')}
                style={{ left: percent(layer.in), right: `calc(100% - ${percent(layer.out)})` }}
              />
              {layer.animated.flatMap((property) => property.times.map((time) => (
                <span
                  key={`${property.path}-${time}`}
                  className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-primary bg-background"
                  style={{ left: percent(time) }}
                  title={`${property.name} ${time.toFixed(2)}s`}
                  data-testid="effect-key"
                />
              )))}
              <span className="pointer-events-none absolute top-0 h-full w-px bg-primary" style={{ left: percent(effect.time) }} aria-hidden="true" />
            </div>
          </div>
        )) : (
          <p className="px-3 py-4 text-muted-foreground">{t('effectKit.noLayers')}</p>
        )}
      </div>
    </div>
  )
}
