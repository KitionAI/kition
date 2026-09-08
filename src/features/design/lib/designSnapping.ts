import type { Bounds, DesignDocument } from './designTypes'
import { nodeBounds, selectionBounds } from './designGeometry'

export type DesignSnapTargets = { x: number[]; y: number[] }
export type DesignSnapGuides = { x?: number; y?: number }

/** Capture stationary geometry once at the start of a move gesture. */
export function designSnapTargets(
  doc: DesignDocument,
  selection: string[],
): DesignSnapTargets {
  const page = doc.pages[0]
  const bounds: Bounds[] = [
    { x: 0, y: 0, width: page.width, height: page.height },
  ]
  for (const id of page.children) {
    const node = doc.nodes[id]
    if (!node.visible || selection.includes(id)) continue
    bounds.push(
      node.type === 'group' ? selectionBounds(doc, [id]) : nodeBounds(node),
    )
  }
  return {
    x: bounds.flatMap((b) => [b.x, b.x + b.width / 2, b.x + b.width]),
    y: bounds.flatMap((b) => [b.y, b.y + b.height / 2, b.y + b.height]),
  }
}

export function snapDesignMove(
  bounds: Bounds,
  dx: number,
  dy: number,
  targets: DesignSnapTargets,
  threshold: number,
) {
  const guides: DesignSnapGuides = {}
  const snap = (axis: 'x' | 'y', offset: number) => {
    const start = bounds[axis] + offset
    const length = axis === 'x' ? bounds.width : bounds.height
    let distance = threshold,
      correction = 0
    for (const target of targets[axis])
      for (const anchor of [start, start + length / 2, start + length]) {
        const delta = target - anchor
        if (Math.abs(delta) < distance) {
          distance = Math.abs(delta)
          correction = delta
          guides[axis] = target
        }
      }
    return offset + correction
  }
  return { dx: snap('x', dx), dy: snap('y', dy), guides }
}
