import {
  getBoardConnectorAnchorAt,
  type BoardConnectorAnchor,
} from './boardBindingEngine'
import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardRectangleElement,
} from './whiteboardTypes'

export type WhiteboardConnectionHandleDirection =
  | 'north'
  | 'east'
  | 'south'
  | 'west'

export type WhiteboardConnectionHandle = {
  anchor: BoardConnectorAnchor
  direction: WhiteboardConnectionHandleDirection
  handlePoint: WhiteboardPoint
}

const HANDLE_DEFINITIONS: ReadonlyArray<{
  anchor: WhiteboardPoint
  direction: WhiteboardConnectionHandleDirection
  normal: WhiteboardPoint
}> = [
  { anchor: { x: 0.5, y: 0 }, direction: 'north', normal: { x: 0, y: -1 } },
  { anchor: { x: 1, y: 0.5 }, direction: 'east', normal: { x: 1, y: 0 } },
  { anchor: { x: 0.5, y: 1 }, direction: 'south', normal: { x: 0, y: 1 } },
  { anchor: { x: 0, y: 0.5 }, direction: 'west', normal: { x: -1, y: 0 } },
]

export function isWhiteboardQuickConnectElement(
  element: WhiteboardElement | undefined,
): element is WhiteboardRectangleElement {
  return Boolean(
    element?.kind === 'rectangle'
      && element.shapeStyle !== 'frame'
      && element.shapeStyle !== 'group'
      && element.shapeStyle !== 'mind-node'
      && element.shapeType !== 'frame',
  )
}

export function getWhiteboardConnectionHandleAnchor(
  direction: WhiteboardConnectionHandleDirection,
) {
  const definition = HANDLE_DEFINITIONS.find((item) => item.direction === direction)
  return definition ? { ...definition.anchor } : null
}

export function getWhiteboardConnectionHandles(input: {
  element: WhiteboardElement
  gap: number
}): WhiteboardConnectionHandle[] {
  if (!isWhiteboardQuickConnectElement(input.element)) return []
  return HANDLE_DEFINITIONS.flatMap((definition) => {
    const anchor = getBoardConnectorAnchorAt(input.element, definition.anchor)
    if (!anchor) return []
    const normal = rotateVector(definition.normal, input.element.rotation ?? 0)
    return [{
      anchor,
      direction: definition.direction,
      handlePoint: {
        x: anchor.point.x + normal.x * input.gap,
        y: anchor.point.y + normal.y * input.gap,
      },
    }]
  })
}

function rotateVector(vector: WhiteboardPoint, degrees: number) {
  if (!degrees) return { ...vector }
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
  }
}
