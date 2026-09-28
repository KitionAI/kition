/**
 * Layout rules for the Design editor: aligning a selection to an edge,
 * distributing layers with equal gaps, and reflowing top-level layers when
 * the artboard changes size. Every function returns world-space matrices
 * per layer; the command reducer applies them, so the rules stay pure.
 */
import { selectionBounds, topSelection } from './designGeometry'
import { DEFAULT_CONSTRAINTS, type Bounds, type DesignDocument, type Matrix } from './designTypes'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type AlignReference = 'selection' | 'artboard'
export type DistributeAxis = 'x' | 'y'

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]

function referenceBounds(doc: DesignDocument, ids: string[], reference: AlignReference): Bounds {
  if (reference === 'artboard' || ids.length < 2) {
    return { x: 0, y: 0, width: doc.pages[0].width, height: doc.pages[0].height }
  }
  return selectionBounds(doc, ids)
}

/**
 * World-space translations that bring each top-level selected layer to
 * `edge` of the reference: the selection's own bounds, or the artboard
 * when asked or when only one layer is selected.
 */
export function alignMoves(doc: DesignDocument, ids: string[], edge: AlignEdge, reference: AlignReference = 'selection'): Map<string, Matrix> {
  const tops = topSelection(doc, ids)
  const target = referenceBounds(doc, tops, reference)
  const moves = new Map<string, Matrix>()
  for (const id of tops) {
    const b = selectionBounds(doc, [id])
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left': dx = target.x - b.x; break
      case 'centerX': dx = target.x + target.width / 2 - (b.x + b.width / 2); break
      case 'right': dx = target.x + target.width - (b.x + b.width); break
      case 'top': dy = target.y - b.y; break
      case 'centerY': dy = target.y + target.height / 2 - (b.y + b.height / 2); break
      case 'bottom': dy = target.y + target.height - (b.y + b.height); break
    }
    if (dx || dy) moves.set(id, translate(dx, dy))
  }
  return moves
}

/**
 * Equal gaps between three or more layers along `axis`, keeping the first
 * and last where they are. Fewer than three layers is a no-op.
 */
export function distributeMoves(doc: DesignDocument, ids: string[], axis: DistributeAxis): Map<string, Matrix> {
  const tops = topSelection(doc, ids)
  const moves = new Map<string, Matrix>()
  if (tops.length < 3) return moves
  const items = tops
    .map((id) => ({ id, bounds: selectionBounds(doc, [id]) }))
    .sort((a, b) => (axis === 'x' ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y))
  const start = axis === 'x' ? items[0].bounds.x : items[0].bounds.y
  const last = items[items.length - 1].bounds
  const end = axis === 'x' ? last.x + last.width : last.y + last.height
  const sizes = items.reduce((sum, item) => sum + (axis === 'x' ? item.bounds.width : item.bounds.height), 0)
  const gap = (end - start - sizes) / (items.length - 1)
  let cursor = start
  for (const item of items) {
    const current = axis === 'x' ? item.bounds.x : item.bounds.y
    const delta = cursor - current
    if (Math.abs(delta) > 1e-6) moves.set(item.id, axis === 'x' ? translate(delta, 0) : translate(0, delta))
    cursor += (axis === 'x' ? item.bounds.width : item.bounds.height) + gap
  }
  return moves
}

/**
 * World-space matrices that reflow top-level layers after the artboard
 * grows or shrinks, following each layer's constraints: anchored edges
 * keep their distance, centered layers keep their relative center, and
 * `scale` stretches position and size with the artboard.
 */
export function artboardResizeMoves(doc: DesignDocument, next: { width: number; height: number }): Map<string, Matrix> {
  const page = doc.pages[0]
  const moves = new Map<string, Matrix>()
  if (next.width === page.width && next.height === page.height) return moves
  const dw = next.width - page.width
  const dh = next.height - page.height
  for (const id of page.children) {
    const node = doc.nodes[id]
    if (!node) continue
    const constraints = node.constraints || DEFAULT_CONSTRAINTS
    let sx = 1
    let sy = 1
    let dx = 0
    let dy = 0
    switch (constraints.horizontal) {
      case 'right': dx = dw; break
      case 'center': dx = dw / 2; break
      case 'scale': sx = next.width / page.width; break
    }
    switch (constraints.vertical) {
      case 'bottom': dy = dh; break
      case 'center': dy = dh / 2; break
      case 'scale': sy = next.height / page.height; break
    }
    if (sx === 1 && sy === 1 && !dx && !dy) continue
    // Scale about the artboard origin, then shift; both act on the world matrix.
    moves.set(id, [sx, 0, 0, sy, dx, dy])
  }
  return moves
}
