import type { RasterViewport } from './rasterViewport'

/** One pointer sample, in document pixels and in client pixels. */
export type KitPointer = {
  x: number
  y: number
  pressure: number
  clientX: number
  clientY: number
  /** The pointer in the canvas's CSS pixels, for placing HTML over it. */
  canvasX: number
  canvasY: number
  shift: boolean
  alt: boolean
  meta: boolean
}

/** Draws a tool's live preview above the canvas, in canvas CSS pixels. */
export type KitOverlay = {
  /** Clears the preview and draws `paint`; `toScreen` maps document points to the canvas. */
  draw: (paint: (context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }) => void) => void
  /** Draws more on top of the current preview (strokes accumulate). */
  add: (paint: (context: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }) => void) => void
  clear: () => void
}

/** What a tool can reach while it handles the pointer. */
export type KitToolContext = {
  viewport: RasterViewport
  overlay: KitOverlay
}

/** One drag, from pointer down to release. */
export type KitGesture = {
  move?: (pointer: KitPointer, context: KitToolContext) => void
  /** The release; the overlay stays until the next document change has painted, unless cleared. */
  end?: (pointer: KitPointer, context: KitToolContext) => void
  cancel?: (context: KitToolContext) => void
}

/**
 * A canvas tool: it turns pointer gestures into engine commands. `begin` gets
 * the press; returning a gesture receives the moves and the release.
 */
export type KitTool = {
  id: string
  cursor: string
  begin: (pointer: KitPointer, context: KitToolContext) => KitGesture | void
  /** The pointer moved with no button held (hover feedback, an open path's rubber band). */
  hover?: (pointer: KitPointer, context: KitToolContext) => void
  /** A double click, after its two presses reached `begin`. */
  doubleClick?: (pointer: KitPointer, context: KitToolContext) => void
}

const MIN_ZOOM_DRAG = 4

/** Drags the view. The canvas also uses it for Space and the middle button. */
export const HAND_TOOL: KitTool = {
  id: 'Hand',
  cursor: 'grab',
  begin: (start) => {
    let last = { x: start.clientX, y: start.clientY }
    return {
      move: (pointer, { viewport }) => {
        viewport.panBy(pointer.clientX - last.x, pointer.clientY - last.y)
        last = { x: pointer.clientX, y: pointer.clientY }
      },
    }
  },
}

/** Click to zoom in at the pointer, Alt-click to zoom out. */
export const ZOOM_TOOL: KitTool = {
  id: 'Zoom',
  cursor: 'zoom-in',
  begin: (start) => ({
    end: (pointer, { viewport }) => {
      const moved = Math.hypot(pointer.clientX - start.clientX, pointer.clientY - start.clientY) > MIN_ZOOM_DRAG
      if (moved) return
      viewport.zoomTo(viewport.view.zoom * (pointer.alt ? 0.5 : 2), pointer.clientX, pointer.clientY)
    },
  }),
}

/** A rectangle from two document points, normalised and rounded to whole pixels. */
export function dragRect(from: { x: number; y: number }, to: { x: number; y: number }, square = false) {
  let dx = to.x - from.x
  let dy = to.y - from.y
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * side
    dy = Math.sign(dy || 1) * side
  }
  const x0 = Math.round(Math.min(from.x, from.x + dx))
  const y0 = Math.round(Math.min(from.y, from.y + dy))
  const x1 = Math.round(Math.max(from.x, from.x + dx))
  const y1 = Math.round(Math.max(from.y, from.y + dy))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
