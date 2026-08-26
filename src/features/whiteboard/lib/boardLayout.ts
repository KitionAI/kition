import {
  getWhiteboardElementBounds,
  getWhiteboardSelectionBounds,
  translateWhiteboardElement,
} from './whiteboardGeometry'
import type { WhiteboardElement } from './whiteboardTypes'

export type BoardAlignment =
  | 'left'
  | 'center-horizontal'
  | 'right'
  | 'top'
  | 'center-vertical'
  | 'bottom'

export type BoardDistribution = 'horizontal' | 'vertical'

export function alignBoardElements(
  elements: readonly WhiteboardElement[],
  alignment: BoardAlignment,
) {
  const selectionBounds = getWhiteboardSelectionBounds(elements)
  if (!selectionBounds || elements.length < 2) return [...elements]
  return elements.map((element) => {
    const bounds = getWhiteboardElementBounds(element)
    const delta = { x: 0, y: 0 }
    switch (alignment) {
      case 'left':
        delta.x = selectionBounds.x - bounds.x
        break
      case 'center-horizontal':
        delta.x = selectionBounds.x + selectionBounds.width / 2
          - (bounds.x + bounds.width / 2)
        break
      case 'right':
        delta.x = selectionBounds.x + selectionBounds.width
          - (bounds.x + bounds.width)
        break
      case 'top':
        delta.y = selectionBounds.y - bounds.y
        break
      case 'center-vertical':
        delta.y = selectionBounds.y + selectionBounds.height / 2
          - (bounds.y + bounds.height / 2)
        break
      case 'bottom':
        delta.y = selectionBounds.y + selectionBounds.height
          - (bounds.y + bounds.height)
        break
    }
    return translateWhiteboardElement(element, delta)
  })
}

export function distributeBoardElements(
  elements: readonly WhiteboardElement[],
  distribution: BoardDistribution,
) {
  if (elements.length < 3) return [...elements]
  const axis = distribution === 'horizontal' ? 'x' : 'y'
  const size = distribution === 'horizontal' ? 'width' : 'height'
  const sorted = elements
    .map((element) => ({ element, bounds: getWhiteboardElementBounds(element) }))
    .sort((left, right) => left.bounds[axis] - right.bounds[axis])
  const first = sorted[0].bounds[axis]
  const last = sorted.at(-1)!
  const available = last.bounds[axis] + last.bounds[size] - first
  const occupied = sorted.reduce((total, item) => total + item.bounds[size], 0)
  const gap = (available - occupied) / (sorted.length - 1)
  let cursor = first
  const positioned = new Map<string, WhiteboardElement>()

  for (const item of sorted) {
    const delta = axis === 'x'
      ? { x: cursor - item.bounds.x, y: 0 }
      : { x: 0, y: cursor - item.bounds.y }
    positioned.set(item.element.id, translateWhiteboardElement(item.element, delta))
    cursor += item.bounds[size] + gap
  }
  return elements.map((element) => positioned.get(element.id) || element)
}
