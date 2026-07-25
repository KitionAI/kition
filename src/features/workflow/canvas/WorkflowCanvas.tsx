import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Minus, Plus } from 'lucide-react'

import { InsertPoint } from './InsertPoint'
import type { InsertableActionType } from './WorkflowNodePicker'

/**
 * WorkflowCanvas owns the "trigger → action" flow shown on the workflow
 * doc body. The canvas is a *viewport* (fixed-size, overflow:hidden) that
 * paints the dotted background and hosts pan / zoom interactions, plus a
 * *content* layer that renders the children with insert slots between them.
 *
 * Interactions follow familiar canvas and node-editor conventions:
 *   - Drag-from-anywhere with a 4px threshold. Clicking a node still selects;
 *     pressing on a node and moving the cursor pans the canvas.
 *   - Wheel pans vertically/horizontally; ⌘/Ctrl + wheel zooms toward the cursor.
 *   - Bottom-left buttons (+ / − / ⛶) zoom in / zoom out / fit-and-center.
 *   - Double-click on the empty background also triggers Fit.
 *   - Keyboard: `0` resets to 100%, `1` fits — only while the canvas has focus.
 *
 * The existing public API (children, onInsertAt, disabled) is unchanged so
 * WorkflowHomePage doesn't need any work. Test ids on existing surfaces
 * (`workflow-canvas`, `workflow-insert-N`, `workflow-canvas-endcap`)
 * are preserved; new ids are exposed for the zoom controls.
 */
export interface WorkflowCanvasProps {
  children: ReactNode | ReactNode[]
  /** Called when the user picks an insertion kind from the "+" popover.
   *  index identifies the slot AFTER which to insert (1-based). */
  onInsertAt?: (index: number, kind: 'filter' | 'action', actionType?: InsertableActionType) => void
  disabled?: boolean
  /** When provided, Backspace/Delete on a focused canvas calls this with
   *  no arguments. Parent decides which node is "selected" and runs the
   *  delete flow (with confirm). */
  onRequestDeleteSelected?: () => void
}

interface Transform {
  scale: number
  tx: number
  ty: number
}

const MIN_SCALE = 0.25
const MAX_SCALE = 2.0
const DRAG_THRESHOLD = 4
const FIT_PADDING = 32
const ZOOM_STEP = 1.2

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function WorkflowCanvas({ children, onInsertAt, disabled, onRequestDeleteSelected }: WorkflowCanvasProps) {
  const { t } = useTranslation('workflow')
  const nodes = (Array.isArray(children) ? children : [children]).filter(Boolean)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState<Transform>({ scale: 1, tx: 24, ty: 24 })
  const transformRef = useRef(transform)
  transformRef.current = transform

  const pressRef = useRef<{
    panning: boolean
    sx: number
    sy: number
    origTx: number
    origTy: number
    pointerId: number
  } | null>(null)
  const suppressClickUntilRef = useRef(0)
  const [panning, setPanning] = useState(false)

  // ---------------------------------------------------------------- helpers
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const el = viewportRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setTransform((cur) => {
      const next = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE)
      if (next === cur.scale) return cur
      const px = clientX - rect.left
      const py = clientY - rect.top
      const ratio = next / cur.scale
      return {
        scale: next,
        tx: px - (px - cur.tx) * ratio,
        ty: py - (py - cur.ty) * ratio,
      }
    })
  }, [])

  const zoomCenter = useCallback(
    (factor: number) => {
      const el = viewportRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // If the viewport has no measurable layout yet (e.g. jsdom in unit
      // tests), still apply a clamped scale update around (0,0) so callers
      // can observe the change. The actual cursor-anchored math degenerates
      // to a no-translate identity, which is the natural fallback.
      const cx = rect.width > 0 ? rect.left + rect.width / 2 : 0
      const cy = rect.height > 0 ? rect.top + rect.height / 2 : 0
      zoomAt(cx, cy, factor)
    },
    [zoomAt],
  )

  const fit = useCallback(() => {
    const vp = viewportRef.current
    const content = contentRef.current
    if (!vp || !content) return
    const vRect = vp.getBoundingClientRect()
    // Measure natural content size by stripping the live transform.
    const prevTransform = content.style.transform
    content.style.transform = 'none'
    const cRect = content.getBoundingClientRect()
    content.style.transform = prevTransform
    const cw = cRect.width
    const ch = cRect.height
    if (cw <= 0 || ch <= 0 || vRect.width <= 0 || vRect.height <= 0) {
      // No layout (jsdom / hidden) — fall back to identity.
      setTransform({ scale: 1, tx: 24, ty: 24 })
      return
    }
    const scaleRaw = Math.min(
      (vRect.width - FIT_PADDING * 2) / cw,
      (vRect.height - FIT_PADDING * 2) / ch,
      1,
    )
    const scale = clamp(scaleRaw, MIN_SCALE, MAX_SCALE)
    setTransform({
      scale,
      tx: Math.max(FIT_PADDING, (vRect.width - cw * scale) / 2),
      ty: FIT_PADDING,
    })
  }, [])

  // ---------------------------------------------------------------- pan
  function shouldStartDrag(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    // Form controls and buttons keep their default click/focus behavior.
    if (target.closest('input, textarea, select, button, [role="menuitem"]')) return false
    return true
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    if (!shouldStartDrag(event.target)) return
    // IMPORTANT: do NOT call setPointerCapture here. Pointer capture retargets
    // the trailing `click` event to the capturing element — that would prevent
    // descendant nodes (e.g. NodeCard) from receiving their own click, and a
    // plain "click a node to select it" would stop working. We only capture
    // once we've decided this gesture is a drag (see onPointerMove).
    pressRef.current = {
      panning: false,
      sx: event.clientX,
      sy: event.clientY,
      origTx: transformRef.current.tx,
      origTy: transformRef.current.ty,
      pointerId: event.pointerId,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const press = pressRef.current
    if (!press) return
    const dx = event.clientX - press.sx
    const dy = event.clientY - press.sy
    if (!press.panning) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      press.panning = true
      setPanning(true)
      // Capture only now — past the drag threshold, the user clearly wants to
      // pan, and capture lets us keep receiving move events even when the
      // pointer leaves the viewport bounds.
      try {
        viewportRef.current?.setPointerCapture(event.pointerId)
      } catch {
        // Best-effort; older jsdom builds don't implement this.
      }
    }
    setTransform((cur) => ({ ...cur, tx: press.origTx + dx, ty: press.origTy + dy }))
  }

  function endPress(event: ReactPointerEvent<HTMLDivElement>) {
    const press = pressRef.current
    if (!press) return
    if (press.panning) {
      // Swallow the synthetic click that follows the pointerup so we don't
      // accidentally select the node we dragged off of.
      suppressClickUntilRef.current = Date.now() + 250
    }
    pressRef.current = null
    setPanning(false)
    try {
      viewportRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // Best-effort; see onPointerDown.
    }
  }

  // Capture-phase click swallower — runs before any descendant's onClick
  // (React's delegate listens in the bubble phase at the root container).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onClick(event: Event) {
      if (Date.now() < suppressClickUntilRef.current) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    el.addEventListener('click', onClick, true)
    return () => {
      el.removeEventListener('click', onClick, true)
    }
  }, [])

  // ---------------------------------------------------------------- wheel
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    function onWheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const factor = Math.exp(-event.deltaY * 0.0015)
        zoomAt(event.clientX, event.clientY, factor)
      } else {
        event.preventDefault()
        setTransform((cur) => ({
          ...cur,
          tx: cur.tx - event.deltaX,
          ty: cur.ty - event.deltaY,
        }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
    }
  }, [zoomAt])

  // ---------------------------------------------------------------- keyboard
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // Delete/Backspace anywhere inside the canvas (as long as the focus
    // isn't a form control) triggers the parent's delete-selected flow.
    // The parent owns the "what's selected" model and the confirm dialog,
    // so this is intentionally just a signal.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const target = event.target as HTMLElement | null
      const isFormField = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
      if (!isFormField && onRequestDeleteSelected) {
        event.preventDefault()
        onRequestDeleteSelected()
        return
      }
    }
    // Only handle pan/zoom keys when the canvas itself (not a child input) has focus.
    if (event.target !== viewportRef.current) return
    if (event.key === '0') {
      event.preventDefault()
      setTransform({ scale: 1, tx: 24, ty: 24 })
    } else if (event.key === '1') {
      event.preventDefault()
      fit()
    }
  }

  // ---------------------------------------------------------------- auto-center on mount
  useLayoutEffect(() => {
    const vp = viewportRef.current
    const content = contentRef.current
    if (!vp || !content) return
    const vRect = vp.getBoundingClientRect()
    const cRect = content.getBoundingClientRect()
    if (vRect.width > 0 && cRect.width > 0) {
      setTransform((cur) => ({
        ...cur,
        tx: Math.max(24, (vRect.width - cRect.width) / 2),
        ty: 24,
      }))
    }
    // Intentionally run once: subsequent resizes don't auto-pan because the
    // user has presumably positioned the canvas themselves by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- render
  return (
    <div
      ref={viewportRef}
      data-testid="workflow-canvas"
      role="application"
      aria-label={t('canvas.workflowCanvas')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        const target = event.target as Element
        // Only fit when the dblclick is on the canvas background or the
        // content wrapper itself — dblclicking a node interior shouldn't
        // refit (the user is likely trying to edit text).
        if (target === viewportRef.current || target === contentRef.current) {
          fit()
        }
      }}
      className={[
        'relative flex flex-1 overflow-hidden rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        // dot-grid uses --hairline-strong so both light and dark themes get a faint, theme-consistent texture
        '[background-image:radial-gradient(circle_at_1px_1px,hsl(var(--hairline-strong))_1px,transparent_0)] [background-size:16px_16px]',
        panning ? 'cursor-grabbing [&_*]:cursor-grabbing' : 'cursor-default',
      ].join(' ')}
      style={{ backgroundPosition: `${transform.tx}px ${transform.ty}px` }}
    >
      <div
        ref={contentRef}
        data-testid="workflow-canvas-content"
        className="absolute left-0 top-0 flex flex-col items-center"
        style={{
          transform: `translate3d(${transform.tx}px, ${transform.ty}px, 0) scale(${transform.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {nodes.map((node, index) => (
          <Fragment key={index}>
            {node}
            <InsertPoint
              onInsert={(kind, actionType) => onInsertAt?.(index + 1, kind, actionType)}
              disabled={disabled}
              testId={`workflow-insert-${index + 1}`}
            />
          </Fragment>
        ))}
        <div
          className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground"
          data-testid="workflow-canvas-endcap"
        >
          End of workflow
        </div>
      </div>

      <ZoomControls
        scale={transform.scale}
        onZoomIn={() => zoomCenter(ZOOM_STEP)}
        onZoomOut={() => zoomCenter(1 / ZOOM_STEP)}
        onFit={fit}
      />
    </div>
  )
}

interface ZoomControlsProps {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

function ZoomControls({ scale, onZoomIn, onZoomOut, onFit }: ZoomControlsProps) {
  const { t } = useTranslation('workflow')
  return (
    <>
      <div
        className="absolute bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_4px_12px_rgba(15,15,15,0.08)]"
        data-testid="workflow-canvas-zoom-controls"
      >
        <button
          type="button"
          aria-label={t('canvas.zoomIn')}
          data-testid="workflow-canvas-zoom-in"
          onClick={onZoomIn}
          className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:bg-muted/40 focus:outline-none"
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('canvas.zoomOut')}
          data-testid="workflow-canvas-zoom-out"
          onClick={onZoomOut}
          className="flex size-8 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:bg-muted/40 focus:outline-none"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('canvas.fitToView')}
          data-testid="workflow-canvas-zoom-fit"
          onClick={onFit}
          className="flex size-8 items-center justify-center border-t border-border text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:bg-muted/40 focus:outline-none"
        >
          <Maximize2 className="size-4" />
        </button>
      </div>
      <div
        className="pointer-events-none absolute bottom-4 left-14 z-10 rounded-md border border-border bg-card/95 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground shadow-sm"
        data-testid="workflow-canvas-zoom-readout"
      >
        {Math.round(scale * 100)}%
      </div>
    </>
  )
}
