import { useCallback, useEffect, useRef, useState } from 'react'
import { setNativeSurfaceShowing } from '@/lib/nativeSurfaces'
import {
  closeKitSurface,
  getKitDocument,
  kitErrorReason,
  listKitCommands,
  openKitSurface,
  updateKitSurface,
  type KitsCommandView,
  type KitsDocumentView,
  type KitsSurfaceRect,
  type KitsSurfaceView,
} from '@/api/kits'

const POLL_INTERVAL_MS = 700
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

/**
 * Web dialogs, menus, and pickers cannot draw over a native window, so the
 * canvas steps aside (its last snapshot shows instead) while one is open.
 */
function useCoveringOverlay() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const selector = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
    const check = () => setOpen(Boolean(document.querySelector(selector)))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
    return () => observer.disconnect()
  }, [])
  return open
}

type UsePhotoSurfaceOptions = {
  path: string
  active: boolean
  /** The editor cannot be embedded here. */
  onUnavailable: () => void
  /** The editor process went away, for example after the user quit it. */
  closedMessage: string
}

/**
 * Runs the kit's native canvas over `regionRef`: opens it, follows the
 * region as the layout changes, hides it while the tab is inactive or a web
 * overlay covers it, and keeps the document view current.
 */
export function usePhotoSurface({ path, active, onUnavailable, closedMessage }: UsePhotoSurfaceOptions) {
  const regionRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<KitsDocumentView | null>(null)
  const [commands, setCommands] = useState<KitsCommandView[]>([])
  const [surfaceId, setSurfaceId] = useState<number | null>(null)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [snapshotVersion, setSnapshotVersion] = useState<number | null>(null)
  const covered = useCoveringOverlay()
  const visible = active && !covered
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
        void listKitCommands(opened.document.kitId, opened.document.documentId)
          .then((list) => {
            if (!cancelled) setCommands(list)
          })
          .catch(() => undefined)
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

  // The kit reports every change, including strokes on the canvas; follow its version.
  useEffect(() => {
    if (!active || !view) return undefined
    const timer = window.setInterval(async () => {
      try {
        const next = await getKitDocument(view.kitId, view.documentId)
        setView((current) => (current && current.version !== next.version ? next : current))
      } catch (error) {
        if (kitErrorReason(error) === 'stopped' || kitErrorReason(error) === 'document_not_found') {
          setFailure(closedMessage)
          setView(null)
        }
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, closedMessage, view])

  // A snapshot of the canvas sits under it, shown whenever the canvas steps aside.
  useEffect(() => {
    if (view && visible) setSnapshotVersion(view.version)
  }, [view, visible])

  const refreshCommands = useCallback(() => {
    if (!view) return
    void listKitCommands(view.kitId, view.documentId).then(setCommands).catch(() => undefined)
  }, [view])

  const reopen = useCallback(() => setAttempt((value) => value + 1), [])

  return { regionRef, view, setView, commands, refreshCommands, failure, reopen, snapshotVersion }
}
