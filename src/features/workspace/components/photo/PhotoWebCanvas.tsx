import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { cn } from '@/lib/utils'
import type { PhotoSdkDocument } from './photoSdk'
import { PhotoViewport, type PhotoView, type PhotoViewportStats } from './photoViewport'

const BACKDROP = '#f3f3f6'
const WHEEL_ZOOM_SPEED = 0.01

/** A stroke in image coordinates: x, y, pressure. */
export type PhotoStrokePoint = [number, number, number]

export type PhotoCanvasHandle = {
  fit: () => void
  zoomTo: (zoom: number) => void
  zoomBy: (factor: number) => void
}

type PhotoWebCanvasProps = {
  doc: PhotoSdkDocument
  /** Moves with every document change; the canvas re-renders when it does. */
  revision: number
  tool: string
  brushSize: number
  /** CSS colour of the brush preview. */
  color: string
  onStroke: (points: PhotoStrokePoint[], erase: boolean) => void
  onPick: (rgb: [number, number, number]) => void
  onView: (view: PhotoView, stats: PhotoViewportStats | null) => void
  ref?: Ref<PhotoCanvasHandle>
}

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'stroke'; points: PhotoStrokePoint[]; erase: boolean; lastX: number; lastY: number }

function cursorFor(tool: string, panning: boolean) {
  if (panning || tool === 'Hand') return 'grab'
  if (tool === 'Zoom') return 'zoom-in'
  return 'crosshair'
}

/** The image, painted by the in-page engine, with Kition's own pointer handling. */
export function PhotoWebCanvas({ doc, revision, tool, brushSize, color, onStroke, onPick, onView, ref }: PhotoWebCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<PhotoViewport | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const latest = useRef({ onView, onStroke, onPick })
  latest.current = { onView, onStroke, onPick }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const viewport = new PhotoViewport(canvas, doc, BACKDROP, (view, stats) => latest.current.onView(view, stats))
    viewportRef.current = viewport
    let fitted = false
    const observer = new ResizeObserver(() => {
      if (!fitted && canvas.clientWidth > 0) {
        fitted = true
        viewport.fit()
      }
      viewport.render()
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
  }, [doc])

  useEffect(() => {
    viewportRef.current?.render()
    const overlay = overlayRef.current
    overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
  }, [revision])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !(event.target instanceof HTMLInputElement)) setSpaceHeld(true)
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
  }, [])

  useImperativeHandle(ref, () => ({
    fit: () => viewportRef.current?.fit(),
    zoomTo: (zoom) => viewportRef.current?.zoomTo(zoom),
    zoomBy: (factor) => {
      const viewport = viewportRef.current
      if (viewport) viewport.zoomTo(viewport.view.zoom * factor)
    },
  }), [])

  const strokePreview = (fromX: number, fromY: number, toX: number, toY: number, erase: boolean) => {
    const overlay = overlayRef.current
    const viewport = viewportRef.current
    const context = overlay?.getContext('2d')
    if (!overlay || !viewport || !context) return
    const dpr = window.devicePixelRatio || 1
    if (overlay.width !== Math.round(overlay.clientWidth * dpr)) {
      overlay.width = Math.round(overlay.clientWidth * dpr)
      overlay.height = Math.round(overlay.clientHeight * dpr)
    }
    const rect = overlay.getBoundingClientRect()
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = Math.max(1, brushSize * viewport.view.zoom)
    context.strokeStyle = erase ? BACKDROP : color
    context.beginPath()
    context.moveTo(fromX - rect.left, fromY - rect.top)
    context.lineTo(toX - rect.left, toY - rect.top)
    context.stroke()
  }

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const viewport = viewportRef.current
    if (!viewport || event.button === 2) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (spaceHeld || tool === 'Hand' || event.button === 1) {
      gesture.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY }
    } else if (tool === 'Zoom') {
      viewport.zoomTo(viewport.view.zoom * (event.altKey ? 0.5 : 2), event.clientX, event.clientY)
    } else if (tool === 'Eyedropper') {
      const rgb = viewport.sample(event.clientX, event.clientY)
      if (rgb) latest.current.onPick(rgb)
    } else if (tool === 'Brush' || tool === 'Eraser') {
      const point = viewport.toImage(event.clientX, event.clientY)
      const erase = tool === 'Eraser'
      gesture.current = { kind: 'stroke', erase, points: [[point.x, point.y, event.pressure || 1]], lastX: event.clientX, lastY: event.clientY }
      strokePreview(event.clientX, event.clientY, event.clientX, event.clientY, erase)
    }
  }

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current
    const viewport = viewportRef.current
    if (!current || !viewport) return
    if (current.kind === 'pan') {
      viewport.panBy(event.clientX - current.lastX, event.clientY - current.lastY)
    } else {
      for (const sample of event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]) {
        const point = viewport.toImage(sample.clientX, sample.clientY)
        current.points.push([point.x, point.y, sample.pressure || 1])
        strokePreview(current.lastX, current.lastY, sample.clientX, sample.clientY, current.erase)
        current.lastX = sample.clientX
        current.lastY = sample.clientY
      }
      return
    }
    current.lastX = event.clientX
    current.lastY = event.clientY
  }

  const pointerUp = () => {
    const current = gesture.current
    gesture.current = null
    if (current?.kind === 'stroke') latest.current.onStroke(current.points, current.erase)
  }

  return (
    <div className="relative size-full overflow-hidden" data-testid="photo-web-canvas">
      <canvas
        ref={canvasRef}
        className={cn('absolute inset-0 size-full touch-none select-none outline-none')}
        style={{ cursor: cursorFor(tool, spaceHeld) }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="photo-web-canvas-surface"
      />
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
    </div>
  )
}
