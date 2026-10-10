import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import type { KitsPhotoDetails } from '@/api/kits'
import { KitEditorFrame, useKitDocument, useKitEditor, type RasterRect, type RasterView, type RasterViewportStats } from '@/features/kits/public'
import { PhotoOptionsBar } from './photo/PhotoOptionsBar'
import { PhotoSidePanel } from './photo/PhotoSidePanel'
import { PhotoToolRail } from './photo/PhotoToolRail'
import { PhotoWebCanvas, type PhotoCanvasHandle, type PhotoStrokePoint } from './photo/PhotoWebCanvas'
import { PHOTO_SDK, describePhoto } from './photo/photoKitSdk'
import { PHOTO_MENU_ORDER, PHOTO_TOOLS } from './photo/photoTools'

/** The tools the in-page canvas handles itself. */
const WEB_TOOL_IDS = new Set(['Brush', 'Eraser', 'Eyedropper', 'Hand', 'Zoom'])
const WEB_TOOLS = PHOTO_TOOLS.filter((tool) => WEB_TOOL_IDS.has(tool.id))
const ZOOM_STEP = 1.25

type PhotoWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

/** The image area a stroke can touch: its points, widened by the brush and a soft edge. */
function strokeBounds(points: readonly PhotoStrokePoint[], size: number): RasterRect {
  const reach = size / 2 + 2
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return {
    x0: Math.floor(Math.min(...xs) - reach),
    y0: Math.floor(Math.min(...ys) - reach),
    x1: Math.ceil(Math.max(...xs) + reach),
    y1: Math.ceil(Math.max(...ys) + reach),
  }
}

function hex(rgb: readonly number[]) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/**
 * A layered image edited in the page, built on the Kit SDK template: the
 * Photo engine runs in a worker and paints into a canvas, the shared kit
 * frame draws the editor, and Photo adds its tools, options, and layers.
 */
export function PhotoWebEditor({ path, active, onOpenAgent }: PhotoWebEditorProps) {
  const { t } = useTranslation('workspace')
  const photo = useKitDocument(PHOTO_SDK, path, active, describePhoto)
  const editor = useKitEditor(photo, { onOpenAgent })
  const canvas = useRef<PhotoCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [tool, setTool] = useState('Brush')
  const [brushSize, setBrushSize] = useState(24)
  const [foreground, setForeground] = useState<[number, number, number]>([0, 0, 0])
  const [zoom, setZoom] = useState<number | null>(null)
  const [stats, setStats] = useState<RasterViewportStats | null>(null)
  const [strokeMs, setStrokeMs] = useState<number | null>(null)
  const { run } = editor

  const stroke = useCallback(async (points: PhotoStrokePoint[], erase: boolean) => {
    const started = performance.now()
    await run('paint.stroke', { points, size: brushSize, color: hex(foreground), erase }, strokeBounds(points, brushSize))
    setStrokeMs(Math.round(performance.now() - started))
  }, [brushSize, foreground, run])

  const details = useMemo<KitsPhotoDetails | null>(() => (photo.state ? {
    ...photo.state.details,
    tool,
    brushSize,
    zoom,
    foreground: [...foreground.map((channel) => channel / 255), 1],
    background: [1, 1, 1, 1],
  } : null), [brushSize, foreground, photo.state, tool, zoom])

  const setOptions = (settings: Record<string, unknown>) => {
    if (typeof settings.tool === 'string') setTool(settings.tool)
    if (typeof settings.brushSize === 'number') setBrushSize(settings.brushSize)
    if (typeof settings.zoom === 'number') canvas.current?.zoomTo(settings.zoom)
    if (settings.fit) canvas.current?.fit()
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (command && key === '0') canvas.current?.fit()
    else if (command && (key === '=' || key === '+')) canvas.current?.zoomBy(ZOOM_STEP)
    else if (command && key === '-') canvas.current?.zoomBy(1 / ZOOM_STEP)
    else if (!command && key === '[') setBrushSize((size) => Math.max(1, Math.round(size / 1.2)))
    else if (!command && key === ']') setBrushSize((size) => Math.min(500, Math.round(size * 1.2)))
    else if (!command && !event.altKey) {
      const match = WEB_TOOLS.find((item) => item.shortcut.toLowerCase() === key)
      if (!match) return
      setTool(match.id)
    } else return
    event.preventDefault()
  }

  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <KitEditorFrame
      document={photo}
      editor={editor}
      title={filename}
      icon={Layers}
      menuOrder={PHOTO_MENU_ORDER}
      menuLabel={(label) => t(`photoKit.menu.${label}`, { defaultValue: label })}
      onKeyDown={keyDown}
      options={<PhotoOptionsBar details={details} onSet={setOptions} />}
      tools={<PhotoToolRail tools={WEB_TOOLS} tool={tool} foreground={details?.foreground} background={details?.background} onSelect={setTool} />}
      side={<PhotoSidePanel details={details} onRun={(command, params) => void run(command, params)} />}
      status={<span>{photo.state?.summary ?? ''}</span>}
      statusEnd={(
        <>
          <span className="tabular-nums" data-testid="photo-web-stats">
            {[
              photo.openMs != null ? t('photoKit.stats.open', { ms: photo.openMs }) : null,
              stats ? t('photoKit.stats.render', { ms: stats.renderMs }) : null,
              strokeMs != null ? t('photoKit.stats.stroke', { ms: strokeMs }) : null,
            ].filter(Boolean).join(' · ')}
          </span>
          {zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
        </>
      )}
    >
      {photo.doc ? (
        <PhotoWebCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={photo.doc}
          change={photo.change}
          tool={tool}
          brushSize={brushSize}
          color={hex(foreground)}
          onStroke={(points, erase) => void stroke(points, erase)}
          onPick={setForeground}
          onView={(view, next) => {
            setZoom(view.zoom)
            if (next) setStats(next)
          }}
        />
      ) : null}
    </KitEditorFrame>
  )
}
