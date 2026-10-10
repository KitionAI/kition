import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, Loader2, Redo2, RefreshCw, Save, Sparkles, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { notify } from '@/lib/notify'
import type { KitsCommandView, KitsPhotoDetails } from '@/api/kits'
import { PhotoMenuBar } from './photo/PhotoMenuBar'
import { PhotoOptionsBar } from './photo/PhotoOptionsBar'
import { PhotoSidePanel } from './photo/PhotoSidePanel'
import { PhotoToolRail } from './photo/PhotoToolRail'
import { PhotoWebCanvas, type PhotoCanvasHandle, type PhotoStrokePoint } from './photo/PhotoWebCanvas'
import { PHOTO_TOOLS } from './photo/photoTools'
import type { PhotoRect, PhotoView, PhotoViewportStats } from './photo/photoViewport'
import { usePhotoDocument } from './photo/usePhotoDocument'

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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** The image area a stroke can touch: its points, widened by the brush and a soft edge. */
function strokeBounds(points: readonly PhotoStrokePoint[], size: number): PhotoRect {
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
 * A layered image edited in the page: the Photo engine runs as WebAssembly
 * and paints into a canvas, and Kition draws the whole editor around it.
 */
export function PhotoWebEditor({ path, active, onOpenAgent }: PhotoWebEditorProps) {
  const { t } = useTranslation('workspace')
  const photo = usePhotoDocument(path, active)
  const canvas = useRef<PhotoCanvasHandle>(null)
  const viewMemory = useRef<PhotoView | null>(null)
  const [tool, setTool] = useState('Brush')
  const [brushSize, setBrushSize] = useState(24)
  const [foreground, setForeground] = useState<[number, number, number]>([0, 0, 0])
  const [zoom, setZoom] = useState<number | null>(null)
  const [stats, setStats] = useState<PhotoViewportStats | null>(null)
  const [strokeMs, setStrokeMs] = useState<number | null>(null)
  const [commands, setCommands] = useState<KitsCommandView[]>([])
  const listCommands = photo.commands

  const refreshCommands = useCallback(() => {
    listCommands().then(setCommands, () => undefined)
  }, [listCommands])

  useEffect(() => {
    if (photo.doc) refreshCommands()
  }, [photo.doc, refreshCommands])

  const run = useCallback(async (command: string, params: Record<string, unknown> = {}) => {
    try {
      await photo.run(command, params)
    } catch (error) {
      notify.error(t('photoKit.commandFailed'), { description: errorText(error) })
    }
  }, [photo, t])

  const save = useCallback(async () => {
    try {
      await photo.save()
      notify.success(t('photoKit.saved'))
    } catch (error) {
      notify.error(t('photoKit.saveFailed'), { description: errorText(error) })
    }
  }, [photo, t])

  const stroke = useCallback(async (points: PhotoStrokePoint[], erase: boolean) => {
    const started = performance.now()
    try {
      await photo.run('paint.stroke', { points, size: brushSize, color: hex(foreground), erase }, strokeBounds(points, brushSize))
    } catch (error) {
      notify.error(t('photoKit.commandFailed'), { description: errorText(error) })
    }
    setStrokeMs(Math.round(performance.now() - started))
  }, [brushSize, foreground, photo, t])

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
    if (event.target instanceof HTMLInputElement) return
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (command && key === 'z') run(event.shiftKey ? 'edit.redo' : 'edit.undo')
    else if (command && key === 's') void save()
    else if (command && key === '0') canvas.current?.fit()
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

  const askAgent = async () => {
    if (photo.dirty) await save()
    onOpenAgent?.()
  }

  const { doc } = photo
  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <div className="flex h-full min-h-0 flex-col bg-background outline-none" tabIndex={-1} onKeyDown={keyDown} data-testid="photo-web-editor">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Layers className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-foreground">{filename}</span>
        {photo.dirty ? (
          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="photo-kit-unsaved">
            {t('photoKit.unsaved')}
          </span>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.undo')} title={t('photoKit.undo')} disabled={!photo.state?.canUndo} onClick={() => run('edit.undo')}>
          <Undo2 className="size-4" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label={t('photoKit.redo')} title={t('photoKit.redo')} disabled={!photo.state?.canRedo} onClick={() => run('edit.redo')}>
          <Redo2 className="size-4" aria-hidden="true" />
        </Button>
        {onOpenAgent ? (
          <Button variant="ghost" size="sm" onClick={() => void askAgent()} data-testid="photo-kit-ask-agent">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('photoKit.askAgent')}
          </Button>
        ) : null}
        <Button size="sm" disabled={!photo.dirty || photo.saving} onClick={() => void save()} data-testid="photo-kit-save">
          {photo.saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Save className="size-3.5" aria-hidden="true" />}
          {t('photoKit.save')}
        </Button>
      </div>
      <PhotoMenuBar commands={commands} onRun={(command) => void run(command.id)} onOpen={refreshCommands} />
      <PhotoOptionsBar details={details} onSet={setOptions} />
      <div className="flex min-h-0 flex-1">
        <PhotoToolRail tools={WEB_TOOLS} tool={tool} foreground={details?.foreground} background={details?.background} onSelect={setTool} />
        <div className="relative min-w-0 flex-1 bg-secondary/40" data-testid="photo-kit-editor-region">
          {photo.conflict ? (
            <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-sm" role="alert" data-testid="photo-file-changed">
              <p className="min-w-0 flex-1 text-[13px] text-foreground">{t('photoKit.changedOnDisk')}</p>
              <Button variant="outline" size="sm" onClick={photo.keepMine}>{t('photoKit.keepMine')}</Button>
              <Button size="sm" onClick={photo.reopen} data-testid="photo-file-reload">{t('photoKit.reloadFile')}</Button>
            </div>
          ) : null}
          {photo.failure ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
                <p className="text-[15px] font-semibold text-foreground">{t('photoKit.openFailed')}</p>
                <p className="mt-2 text-[13px] text-muted-foreground">{photo.failure}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={photo.reopen}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t('photoKit.reopen')}
                </Button>
              </div>
            </div>
          ) : doc && photo.state ? (
            <PhotoWebCanvas
              ref={canvas}
              viewMemory={viewMemory}
              doc={doc}
              change={photo.change}
              tool={tool}
              brushSize={brushSize}
              color={hex(foreground)}
              onStroke={stroke}
              onPick={setForeground}
              onView={(view, next) => {
                setZoom(view.zoom)
                if (next) setStats(next)
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t('photoKit.loading')}
            </div>
          )}
        </div>
        <PhotoSidePanel details={details} onRun={run} />
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground" data-testid="photo-status-bar">
        <span>{photo.state?.summary ?? ''}</span>
        <div className="flex-1" />
        <span className="tabular-nums" data-testid="photo-web-stats">
          {[
            photo.openMs != null ? t('photoKit.stats.open', { ms: photo.openMs }) : null,
            stats ? t('photoKit.stats.render', { ms: stats.renderMs }) : null,
            strokeMs != null ? t('photoKit.stats.stroke', { ms: strokeMs }) : null,
          ].filter(Boolean).join(' · ')}
        </span>
        {zoom != null ? <span className="tabular-nums">{Math.round(zoom * 100)}%</span> : null}
      </div>
    </div>
  )
}
