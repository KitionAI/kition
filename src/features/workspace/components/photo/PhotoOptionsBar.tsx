import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui'
import type { KitsPhotoDetails } from '@/api/kits'
import { toolFor } from './photoTools'

const BRUSH_COMMIT_MS = 120
const ZOOM_STEP = 1.25

/** The brush size slider: moves freely, and sends the size to the kit at most every 120 ms. */
function BrushSize({ size, label, onCommit }: { size: number; label: string; onCommit: (size: number) => void }) {
  const [value, setValue] = useState(Math.round(size))
  const timer = useRef<number | undefined>(undefined)
  const dragging = useRef(false)
  useEffect(() => {
    if (!dragging.current) setValue(Math.round(size))
  }, [size])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const change = (next: number) => {
    setValue(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onCommit(next), BRUSH_COMMIT_MS)
  }
  return (
    <label className="flex items-center gap-2 text-muted-foreground">
      {label}
      <input
        type="range"
        min={1}
        max={500}
        value={value}
        onPointerDown={() => { dragging.current = true }}
        onPointerUp={() => { dragging.current = false }}
        onChange={(event) => change(Number(event.target.value))}
        className="w-32 accent-[hsl(var(--primary))]"
        aria-label={label}
        data-testid="photo-brush-size"
      />
      <span className="w-14 tabular-nums text-foreground">{value} px</span>
    </label>
  )
}

type PhotoOptionsBarProps = {
  details: KitsPhotoDetails | null
  /** Sets editor UI state through the kit (`ui.set`): tool, brush size, zoom. */
  onSet: (settings: Record<string, unknown>) => void
  /** The active tool's other options, after its name. */
  children?: ReactNode
}

/** The active tool's options and the zoom controls, above the canvas. */
export function PhotoOptionsBar({ details, onSet, children }: PhotoOptionsBarProps) {
  const { t } = useTranslation('workspace')
  const tool = toolFor(details?.tool)
  const zoom = typeof details?.zoom === 'number' ? details.zoom : null
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3 text-[13px]" data-testid="photo-options-bar">
      <span className="font-medium text-foreground">{tool ? t(`photoKit.tools.${tool.label}`) : details?.tool ?? ''}</span>
      {tool?.painting ? <BrushSize size={details?.brushSize ?? 20} label={t('photoKit.brushSize')} onCommit={(size) => onSet({ brushSize: size })} /> : null}
      {children}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon" className="size-7" aria-label={t('photoKit.zoomOut')} title={t('photoKit.zoomOut')} disabled={zoom == null} onClick={() => zoom && onSet({ zoom: Math.max(0.01, zoom / ZOOM_STEP) })}>
          <Minus className="size-3.5" aria-hidden="true" />
        </Button>
        <span className="w-12 text-center tabular-nums text-muted-foreground" data-testid="photo-zoom">{zoom != null ? `${Math.round(zoom * 100)}%` : '—'}</span>
        <Button variant="ghost" size="icon" className="size-7" aria-label={t('photoKit.zoomIn')} title={t('photoKit.zoomIn')} disabled={zoom == null} onClick={() => zoom && onSet({ zoom: Math.min(64, zoom * ZOOM_STEP) })}>
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" aria-label={t('photoKit.fitOnScreen')} title={t('photoKit.fitOnScreen')} onClick={() => onSet({ fit: true })}>
          <Maximize className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
