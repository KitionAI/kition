import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import type { KitsPhotoDetails } from '@/api/kits'
import {
  KITION_KIT_HOST,
  KitCanvas,
  KitEditorFrame,
  useKitDocument,
  useKitEditor,
  type KitCanvasHandle,
  type RasterView,
  type RasterViewportStats,
} from '@/features/kits/public'
import { PhotoOptionsBar } from './photo/PhotoOptionsBar'
import { PhotoSidePanel } from './photo/PhotoSidePanel'
import { PhotoTextField, type PhotoTextDraft } from './photo/PhotoTextField'
import { PhotoToolOptions } from './photo/PhotoToolOptions'
import { PhotoToolRail } from './photo/PhotoToolRail'
import { photoCanvasTool } from './photo/photoCanvasTools'
import { PHOTO_SDK, describePhoto } from './photo/photoKitSdk'
import { PHOTO_MENU_ORDER, PHOTO_TOOLS } from './photo/photoTools'
import { usePhotoOverlays, type CropArea } from './photo/usePhotoOverlays'

/** The tools the in-page canvas handles. */
const WEB_TOOL_IDS = new Set(['Move', 'RectMarquee', 'Lasso', 'MagicWand', 'Crop', 'Eyedropper', 'SpotHealing', 'Brush', 'CloneStamp', 'HistoryBrush', 'Eraser', 'Gradient', 'PaintBucket', 'Blur', 'Dodge', 'Rectangle', 'Type', 'Hand', 'Zoom'])
const WEB_TOOLS = PHOTO_TOOLS.filter((tool) => WEB_TOOL_IDS.has(tool.id))
const ZOOM_STEP = 1.25

type PhotoWebEditorProps = {
  path: string
  /** The tab is in front; only then does the editor follow changes to the file. */
  active: boolean
  onOpenAgent?: () => void
}

function hex(rgb: readonly number[]) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** The tool chosen by a key: the first tool with that shortcut, or the next one when it is already active. */
function toolForKey(key: string, current: string) {
  const matches = WEB_TOOLS.filter((item) => item.shortcut.toLowerCase() === key)
  if (!matches.length) return null
  const index = matches.findIndex((item) => item.id === current)
  return matches[(index + 1) % matches.length].id
}

/**
 * A layered image edited in the page, built on the Kit SDK template: the
 * Photo engine runs in a worker and paints into the kit canvas, the shared
 * kit frame draws the editor, and Photo adds its tools, options, and layers.
 */
export function PhotoWebEditor({ path, active, onOpenAgent }: PhotoWebEditorProps) {
  const { t } = useTranslation('workspace')
  const photo = useKitDocument(KITION_KIT_HOST, PHOTO_SDK, path, active, describePhoto)
  const editor = useKitEditor(photo, { onOpenAgent })
  const canvas = useRef<KitCanvasHandle>(null)
  const viewMemory = useRef<RasterView | null>(null)
  const [tool, setTool] = useState('Brush')
  const [brushSize, setBrushSize] = useState(24)
  const [foreground, setForeground] = useState<[number, number, number]>([0, 0, 0])
  const [background, setBackground] = useState<[number, number, number]>([255, 255, 255])
  const [shapeKind, setShapeKind] = useState<'rect' | 'ellipse'>('rect')
  const [fontSize, setFontSize] = useState(48)
  const [crop, setCrop] = useState<CropArea | null>(null)
  const [textDraft, setTextDraft] = useState<PhotoTextDraft | null>(null)
  const [cloneSource, setCloneSource] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [stats, setStats] = useState<RasterViewportStats | null>(null)
  const { run } = editor
  const overlays = usePhotoOverlays(photo.doc, photo.change, photo.state?.hasSelection ?? false, zoom, tool === 'Crop' ? crop : null)

  const canvasTool = useMemo(() => photoCanvasTool(tool, {
    brushSize,
    foreground: hex(foreground),
    background: hex(background),
    shapeKind,
    layerBounds: photo.state?.activeBounds ?? null,
    run,
    pick: setForeground,
    proposeCrop: setCrop,
    beginText: (pointer) => setTextDraft({ x: pointer.x, y: pointer.y, left: pointer.canvasX, top: pointer.canvasY }),
    cloneSource,
    setCloneSource,
  }), [background, brushSize, cloneSource, foreground, photo.state?.activeBounds, run, shapeKind, tool])

  const details = useMemo<KitsPhotoDetails | null>(() => (photo.state ? {
    ...photo.state.details,
    tool,
    brushSize,
    zoom,
    foreground: [...foreground.map((channel) => channel / 255), 1],
    background: [...background.map((channel) => channel / 255), 1],
  } : null), [background, brushSize, foreground, photo.state, tool, zoom])

  const chooseTool = (next: string) => {
    setTool(next)
    setCrop(null)
  }

  const applyCrop = async () => {
    if (!crop) return
    const area = crop
    setCrop(null)
    if (await run('image.crop', area)) canvas.current?.fit()
  }

  const setOptions = (settings: Record<string, unknown>) => {
    if (typeof settings.tool === 'string') chooseTool(settings.tool)
    if (typeof settings.brushSize === 'number') setBrushSize(settings.brushSize)
    if (typeof settings.zoom === 'number') canvas.current?.zoomTo(settings.zoom)
    if (settings.fit) canvas.current?.fit()
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (crop && key === 'enter') void applyCrop()
    else if (crop && key === 'escape') setCrop(null)
    else if (command && key === '0') canvas.current?.fit()
    else if (command && (key === '=' || key === '+')) canvas.current?.zoomBy(ZOOM_STEP)
    else if (command && key === '-') canvas.current?.zoomBy(1 / ZOOM_STEP)
    else if (!command && !event.altKey && key === '[') setBrushSize((size) => Math.max(1, Math.round(size / 1.2)))
    else if (!command && !event.altKey && key === ']') setBrushSize((size) => Math.min(500, Math.round(size * 1.2)))
    else if (!command && !event.altKey && key === 'x') {
      setForeground(background)
      setBackground(foreground)
    } else if (!command && !event.altKey && key === 'd') {
      setForeground([0, 0, 0])
      setBackground([255, 255, 255])
    } else if (!command && !event.altKey && !event.shiftKey && toolForKey(key, tool)) chooseTool(toolForKey(key, tool)!)
    else return
    event.preventDefault()
  }

  const placeText = (text: string) => {
    const draft = textDraft
    setTextDraft(null)
    if (draft) void run('type.create', { x: Math.round(draft.x), y: Math.round(draft.y), text, size: fontSize, color: hex(foreground) })
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
      options={(
        <PhotoOptionsBar details={details} onSet={setOptions}>
          <PhotoToolOptions
            tool={tool}
            shapeKind={shapeKind}
            onShapeKind={setShapeKind}
            fontSize={fontSize}
            onFontSize={setFontSize}
            cropProposed={crop != null}
            cloneSourceSet={cloneSource != null}
            onApplyCrop={() => void applyCrop()}
            onCancelCrop={() => setCrop(null)}
          />
        </PhotoOptionsBar>
      )}
      tools={<PhotoToolRail tools={WEB_TOOLS} tool={tool} foreground={details?.foreground} background={details?.background} onSelect={chooseTool} />}
      side={<PhotoSidePanel details={details} onRun={(command, params) => void run(command, params)} />}
      status={<span>{photo.state?.summary ?? ''}</span>}
      statusEnd={(
        <>
          <span className="tabular-nums" data-testid="photo-web-stats">
            {[
              photo.openMs != null ? t('photoKit.stats.open', { ms: photo.openMs }) : null,
              stats ? t('photoKit.stats.render', { ms: stats.renderMs }) : null,
            ].filter(Boolean).join(' · ')}
          </span>
          {zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
        </>
      )}
    >
      {photo.doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory}
          doc={photo.doc}
          change={photo.change}
          tool={canvasTool}
          decorate={overlays.decorate}
          animated={overlays.animated}
          onView={(view, next) => {
            setZoom(view.zoom)
            if (next) setStats(next)
          }}
        >
          {textDraft ? (
            <PhotoTextField draft={textDraft} size={fontSize} zoom={zoom ?? 1} color={hex(foreground)} onCommit={placeText} onCancel={() => setTextDraft(null)} />
          ) : null}
        </KitCanvas>
      ) : null}
    </KitEditorFrame>
  )
}
