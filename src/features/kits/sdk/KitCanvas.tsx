import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from 'react'
import type { KitEngine } from './kitEngine'
import { HAND_TOOL, type KitGesture, type KitOverlay, type KitPointer, type KitTool, type KitToolContext } from './kitTools'
import { RasterViewport, type RasterDecoration, type RasterRect, type RasterView, type RasterViewportStats } from './rasterViewport'
import type { KitChange } from './useKitDocument'

const BACKDROP = '#f3f3f6'
const WHEEL_ZOOM_SPEED = 0.01
const DECORATION_FRAME_MS = 100

export type KitCanvasHandle = {
  fit: () => void
  /** Fits an area of the document (a page, a spread) in view. */
  show: (area: RasterRect) => void
  zoomTo: (zoom: number) => void
  zoomBy: (factor: number) => void
}

type KitCanvasProps = {
  doc: KitEngine
  /** Moves with every document change; the canvas repaints what it names. */
  change: KitChange
  tool: KitTool
  onView: (view: RasterView, stats: RasterViewportStats | null) => void
  /** The last view, kept when the document is replaced by a newer version of the file. */
  viewMemory: RefObject<RasterView | null>
  /** Drawn over the document on every frame; `animated` redraws it continuously (marching ants). */
  decorate?: RasterDecoration | null
  animated?: boolean
  /** The area the first view fits (a layout's first spread); the whole document by default. */
  initialArea?: RasterRect | null
  /** Whether holding Space pans (on by default); a player uses Space for play and pause. */
  spacePans?: boolean
  /** HTML laid over the canvas, for example an inline text field. */
  children?: ReactNode
  ref?: Ref<KitCanvasHandle>
}

function pointerOf(event: { clientX: number; clientY: number; pressure: number; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }, viewport: RasterViewport): KitPointer {
  const point = viewport.toImage(event.clientX, event.clientY)
  const local = viewport.toScreen(point.x, point.y)
  return {
    x: point.x,
    y: point.y,
    pressure: event.pressure || 1,
    clientX: event.clientX,
    clientY: event.clientY,
    canvasX: local.x,
    canvasY: local.y,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey || event.ctrlKey,
  }
}

function useOverlay(overlayRef: RefObject<HTMLCanvasElement | null>, viewportRef: RefObject<RasterViewport | null>): KitOverlay {
  const paint = (clear: boolean, draw: Parameters<KitOverlay['draw']>[0]) => {
    const overlay = overlayRef.current
    const viewport = viewportRef.current
    const context = overlay?.getContext('2d')
    if (!overlay || !viewport || !context) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(overlay.clientWidth * dpr)
    const height = Math.round(overlay.clientHeight * dpr)
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width
      overlay.height = height
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (clear) context.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight)
    context.save()
    draw(context, (x, y) => viewport.toScreen(x, y))
    context.restore()
  }
  return {
    draw: (draw) => paint(true, draw),
    add: (draw) => paint(false, draw),
    clear: () => {
      const overlay = overlayRef.current
      overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
    },
  }
}

/**
 * A kit document on a canvas, with Kition's pointer handling: the active
 * tool gets gestures in document pixels; Space, the middle button, and the
 * Hand tool pan; the wheel pans, and zooms with Cmd or Ctrl (and pinch).
 */
export function KitCanvas({ doc, change, tool, onView, viewMemory, initialArea = null, decorate = null, animated = false, spacePans = true, children, ref }: KitCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<RasterViewport | null>(null)
  const gesture = useRef<KitGesture | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const latest = useRef({ onView, initialArea })
  latest.current = { onView, initialArea }
  const overlay = useOverlay(overlayRef, viewportRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    // Remember the view only once it is placed (fitted, or carried over), never the default.
    let placed = viewMemory.current != null
    const viewport = new RasterViewport(canvas, doc, BACKDROP, (view, stats) => {
      if (placed) viewMemory.current = view
      latest.current.onView(view, stats)
    })
    viewportRef.current = viewport
    if (viewMemory.current) viewport.view = { ...viewMemory.current }
    const observer = new ResizeObserver(() => {
      if (!placed && canvas.clientWidth > 0) {
        placed = true
        const area = latest.current.initialArea
        if (area) viewport.fitArea(area)
        else viewport.fit()
      }
      void viewport.render()
    })
    observer.observe(canvas)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) viewport.zoomTo(viewport.view.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), event.clientX, event.clientY)
      else viewport.panBy(-event.deltaX, -event.deltaY)
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      canvas.removeEventListener('wheel', wheel)
      viewport.dispose()
      viewportRef.current = null
    }
  }, [doc, viewMemory])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    // A tool's preview stays until the engine's pixels replace it.
    void (change.damage ? viewport.renderArea(change.damage) : viewport.render()).then(() => overlay.clear())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repaint once per change
  }, [change])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.decorate = decorate
    viewport.draw()
    if (!animated || !decorate) return undefined
    const timer = window.setInterval(() => viewport.draw(), DECORATION_FRAME_MS)
    return () => window.clearInterval(timer)
  }, [animated, decorate, doc])

  useEffect(() => {
    if (!spacePans) return undefined
    const editable = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !editable(event.target)) setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [spacePans])

  useImperativeHandle(ref, () => ({
    fit: () => viewportRef.current?.fit(),
    show: (area) => viewportRef.current?.fitArea(area),
    zoomTo: (zoom) => viewportRef.current?.zoomTo(zoom),
    zoomBy: (factor) => {
      const viewport = viewportRef.current
      if (viewport) viewport.zoomTo(viewport.view.zoom * factor)
    },
  }), [])

  const context = (): KitToolContext | null => (viewportRef.current ? { viewport: viewportRef.current, overlay } : null)

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    if (!tools || event.button === 2) return
    // Keyboard focus goes to the editor now (committing any open field), not on the browser's
    // mousedown afterwards, so a field a tool opens (Type) keeps the focus it takes.
    event.preventDefault()
    const editor = event.currentTarget.closest<HTMLElement>('[tabindex]')
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const active = spaceHeld || event.button === 1 ? HAND_TOOL : tool
    gesture.current = active.begin(pointerOf(event, tools.viewport), tools) || null
  }

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    if (tools && !current && !spaceHeld && event.buttons === 0) tool.hover?.(pointerOf(event, tools.viewport), tools)
    if (!tools || !current?.move) return
    for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
      current.move(pointerOf(sample, tools.viewport), tools)
    }
  }

  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tools = context()
    const current = gesture.current
    gesture.current = null
    if (tools && current) current.end?.(pointerOf(event, tools.viewport), tools)
  }

  const pointerCancel = () => {
    const tools = context()
    const current = gesture.current
    gesture.current = null
    if (tools && current) current.cancel?.(tools)
    overlay.clear()
  }

  return (
    <div className="relative size-full overflow-hidden" data-testid="kit-canvas">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-none select-none outline-none"
        style={{ cursor: spaceHeld ? HAND_TOOL.cursor : tool.cursor }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
        onDoubleClick={(event) => {
          const tools = context()
          if (tools) tool.doubleClick?.(pointerOf({ ...event, clientX: event.clientX, clientY: event.clientY, pressure: 1 }, tools.viewport), tools)
        }}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="kit-canvas-surface"
      />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
      {children}
    </div>
  )
}
