import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui'
import { setNativeSurfaceShowing } from '@/lib/nativeSurfaces'
import {
  closeKitSurface,
  getKitDocument,
  kitErrorReason,
  openKitSurface,
  updateKitSurface,
  type KitsDocumentView,
  type KitsSurfaceRect,
  type KitsSurfaceView,
} from '@/api/kits'

const POLL_INTERVAL_MS = 2000
const PLACEMENT_CHECK_MS = 250
/** Keeps the editor alive across a quick remount (development double effects, re-renders). */
const CLOSE_DELAY_MS = 400

type SurfaceEntry = {
  opening: Promise<KitsSurfaceView>
  refs: number
  closeTimer?: number
}

const surfaces = new Map<string, SurfaceEntry>()

function acquireSurface(path: string, rect: KitsSurfaceRect, visible: boolean) {
  const existing = surfaces.get(path)
  if (existing) {
    existing.refs += 1
    window.clearTimeout(existing.closeTimer)
    return existing.opening
  }
  const opening = openKitSurface(path, rect, visible)
  surfaces.set(path, { opening, refs: 1 })
  opening.catch(() => surfaces.delete(path))
  return opening
}

function releaseSurface(path: string) {
  const entry = surfaces.get(path)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  entry.closeTimer = window.setTimeout(() => {
    if (surfaces.get(path) !== entry || entry.refs > 0) return
    surfaces.delete(path)
    void entry.opening.then((view) => closeKitSurface(view.surfaceId)).catch(() => undefined)
  }, CLOSE_DELAY_MS)
}

function measure(element: HTMLElement | null): KitsSurfaceRect | null {
  if (!element) return null
  const box = element.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return null
  return { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
}

function sameRect(a: KitsSurfaceRect | null, b: KitsSurfaceRect | null) {
  return a?.x === b?.x && a?.y === b?.y && a?.width === b?.width && a?.height === b?.height
}

/** A native window cannot sit under web dialogs, so the editor hides while one is open. */
function useDialogOpen() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const check = () => setOpen(Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]')))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
    return () => observer.disconnect()
  }, [])
  return open
}

type PhotoKitEditorProps = {
  path: string
  active: boolean
  onOpenAgent?: () => void
  /** The editor cannot be embedded here; the tab falls back to its preview. */
  onUnavailable: () => void
}

/**
 * The Photo kit's own editor, embedded: the kit draws its native window
 * exactly over this tab's content area. This component reserves the area,
 * reports where it is, and says when the editor should show.
 */
export function PhotoKitEditor({ path, active, onOpenAgent, onUnavailable }: PhotoKitEditorProps) {
  const { t } = useTranslation('workspace')
  const regionRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<KitsDocumentView | null>(null)
  const [surfaceId, setSurfaceId] = useState<number | null>(null)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const dialogOpen = useDialogOpen()
  const visible = active && !dialogOpen
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const showingKey = `photo:${path}`

  useEffect(() => {
    let cancelled = false
    setFailure('')
    setView(null)
    setSurfaceId(null)
    const rect = measure(regionRef.current) || { x: 0, y: 0, width: 1, height: 1 }
    acquireSurface(path, rect, visibleRef.current)
      .then((opened) => {
        if (cancelled) return
        setSurfaceId(opened.surfaceId)
        setView(opened.document)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (kitErrorReason(error) === 'unavailable') {
          onUnavailable()
          return
        }
        setFailure(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
      setNativeSurfaceShowing(showingKey, false)
      releaseSurface(path)
    }
  }, [attempt, onUnavailable, path, showingKey])

  useEffect(() => {
    if (surfaceId == null) return
    setNativeSurfaceShowing(showingKey, visible)
    void updateKitSurface(surfaceId, { visible, rect: measure(regionRef.current) ?? undefined }).catch(() => undefined)
  }, [showingKey, surfaceId, visible])

  // Follow the content area: sidebar and Agent pane changes move it without a window resize.
  useEffect(() => {
    const region = regionRef.current
    if (surfaceId == null || !region) return undefined
    let last = measure(region)
    const report = () => {
      const next = measure(region)
      if (!next || sameRect(next, last)) return
      last = next
      void updateKitSurface(surfaceId, { rect: next }).catch(() => undefined)
    }
    const observer = new ResizeObserver(report)
    observer.observe(region)
    window.addEventListener('resize', report)
    const timer = window.setInterval(report, PLACEMENT_CHECK_MS)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(timer)
    }
  }, [surfaceId])

  useEffect(() => {
    if (!active || !view) return undefined
    const timer = window.setInterval(async () => {
      try {
        const next = await getKitDocument(view.kitId, view.documentId)
        setView((current) => (current && (current.dirty !== next.dirty || current.version !== next.version) ? next : current))
      } catch (error) {
        if (kitErrorReason(error) === 'stopped' || kitErrorReason(error) === 'document_not_found') {
          setFailure(t('photoKit.editorClosed'))
          setView(null)
        }
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, t, view])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])
  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="photo-kit-editor">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Layers className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-foreground">{filename}</span>
        {view?.dirty ? (
          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="photo-kit-unsaved">
            {t('photoKit.unsaved')}
          </span>
        ) : null}
        <div className="flex-1" />
        {onOpenAgent ? (
          <Button variant="ghost" size="sm" onClick={onOpenAgent} data-testid="photo-kit-ask-agent">
            <Sparkles className="size-3.5" aria-hidden="true" />
            {t('photoKit.askAgent')}
          </Button>
        ) : null}
      </div>
      <div ref={regionRef} className="relative min-h-0 flex-1 bg-secondary/40" data-testid="photo-kit-editor-region">
        {failure ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-md rounded-xl border border-border bg-background p-6 text-center">
              <p className="text-[15px] font-semibold text-foreground">{t('photoKit.openFailed')}</p>
              <p className="mt-2 text-[13px] text-muted-foreground">{failure}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={reopen}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t('photoKit.reopen')}
              </Button>
            </div>
          </div>
        ) : view ? null : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('photoKit.openingEditor')}
          </div>
        )}
      </div>
    </div>
  )
}
