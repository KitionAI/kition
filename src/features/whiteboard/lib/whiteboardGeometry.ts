import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardResizeHandle,
  WhiteboardViewport,
} from './whiteboardTypes'
import { getBoardElementUnrotatedBounds } from './boardElementDefinitions'

export const WHITEBOARD_MIN_ZOOM = 0.25
export const WHITEBOARD_MAX_ZOOM = 4
const MIN_TRANSFORM_SIZE = 8

export function clampWhiteboardZoom(zoom: number) {
  return Math.min(WHITEBOARD_MAX_ZOOM, Math.max(WHITEBOARD_MIN_ZOOM, zoom))
}

export function normalizeWhiteboardBounds(
  start: WhiteboardPoint,
  end: WhiteboardPoint,
): WhiteboardBounds {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function screenToWhiteboardPoint(
  point: WhiteboardPoint,
  viewport: WhiteboardViewport,
): WhiteboardPoint {
  return {
    x: viewport.x + point.x / viewport.zoom,
    y: viewport.y + point.y / viewport.zoom,
  }
}

export function whiteboardToScreenPoint(
  point: WhiteboardPoint,
  viewport: WhiteboardViewport,
): WhiteboardPoint {
  return {
    x: (point.x - viewport.x) * viewport.zoom,
    y: (point.y - viewport.y) * viewport.zoom,
  }
}

export function translateWhiteboardElement(
  element: WhiteboardElement,
  delta: WhiteboardPoint,
): WhiteboardElement {
  switch (element.kind) {
    case 'rectangle':
    case 'image':
    case 'text':
      return { ...element, x: element.x + delta.x, y: element.y + delta.y }
    case 'stroke':
      return {
        ...element,
        points: element.points.map((point) => ({
          x: point.x + delta.x,
          y: point.y + delta.y,
        })),
      }
    case 'connector':
      return {
        ...element,
        start: {
          x: element.start.x + delta.x,
          y: element.start.y + delta.y,
        },
        end: {
          x: element.end.x + delta.x,
          y: element.end.y + delta.y,
        },
      }
  }
}

export function getWhiteboardElementBounds(
  element: WhiteboardElement,
): WhiteboardBounds {
  const bounds = getWhiteboardElementUnrotatedBounds(element)
  const rotation = normalizeRotation(element.rotation ?? 0)
  if (rotation === 0) return bounds
  const center = getBoundsCenter(bounds)
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => rotateWhiteboardPoint(point, center, rotation))
  return boundsForPoints(corners)
}

export function getWhiteboardElementCenter(element: WhiteboardElement) {
  return getBoundsCenter(getWhiteboardElementUnrotatedBounds(element))
}

export function getWhiteboardSelectionBounds(
  elements: readonly WhiteboardElement[],
): WhiteboardBounds | null {
  if (elements.length === 0) return null
  return unionWhiteboardBounds(elements.map(getWhiteboardElementBounds))
}

export function getWhiteboardContentBounds(
  elements: readonly WhiteboardElement[],
): WhiteboardBounds | null {
  return getWhiteboardSelectionBounds(elements)
}

export function whiteboardBoundsIntersect(
  left: WhiteboardBounds,
  right: WhiteboardBounds,
) {
  return left.x <= right.x + right.width
    && left.x + left.width >= right.x
    && left.y <= right.y + right.height
    && left.y + left.height >= right.y
}

export function resizeWhiteboardElements(input: {
  elements: readonly WhiteboardElement[]
  handle: WhiteboardResizeHandle
  selectionBounds: WhiteboardBounds
  point: WhiteboardPoint
  fromCenter?: boolean
  lockAspectRatio?: boolean
}) {
  const nextBounds = getResizedBounds({
    bounds: input.selectionBounds,
    fromCenter: Boolean(input.fromCenter),
    handle: input.handle,
    lockAspectRatio: Boolean(input.lockAspectRatio),
    point: input.point,
  })
  return input.elements.map((element) => (
    resizeWhiteboardElement(element, input.selectionBounds, nextBounds)
  ))
}

export function rotateWhiteboardElements(input: {
  elements: readonly WhiteboardElement[]
  origin: WhiteboardPoint
  start: WhiteboardPoint
  point: WhiteboardPoint
  snap?: boolean
}) {
  const startAngle = Math.atan2(
    input.start.y - input.origin.y,
    input.start.x - input.origin.x,
  )
  const currentAngle = Math.atan2(
    input.point.y - input.origin.y,
    input.point.x - input.origin.x,
  )
  let delta = ((currentAngle - startAngle) * 180) / Math.PI
  if (input.snap) delta = Math.round(delta / 15) * 15
  return input.elements.map((element) => (
    rotateWhiteboardElement(element, input.origin, delta)
  ))
}

export function rotateWhiteboardPoint(
  point: WhiteboardPoint,
  origin: WhiteboardPoint,
  degrees: number,
): WhiteboardPoint {
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const x = point.x - origin.x
  const y = point.y - origin.y
  return {
    x: origin.x + x * cosine - y * sine,
    y: origin.y + x * sine + y * cosine,
  }
}

export function whiteboardPointsToPath(points: readonly WhiteboardPoint[]) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  }
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]
    const next = points[index + 1]
    const midpoint = {
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2,
    }
    path += ` Q ${current.x} ${current.y} ${midpoint.x} ${midpoint.y}`
  }
  const last = points[points.length - 1]
  path += ` L ${last.x} ${last.y}`
  return path
}

function getWhiteboardElementUnrotatedBounds(
  element: WhiteboardElement,
): WhiteboardBounds {
  return getBoardElementUnrotatedBounds(element)
}

function getResizedBounds(input: {
  bounds: WhiteboardBounds
  fromCenter: boolean
  handle: WhiteboardResizeHandle
  lockAspectRatio: boolean
  point: WhiteboardPoint
}) {
  const start = input.bounds
  const center = getBoundsCenter(start)
  let left = start.x
  let right = start.x + start.width
  let top = start.y
  let bottom = start.y + start.height

  if (input.handle.includes('west')) left = input.point.x
  if (input.handle.includes('east')) right = input.point.x
  if (input.handle.includes('north')) top = input.point.y
  if (input.handle.includes('south')) bottom = input.point.y

  if (input.fromCenter) {
    if (input.handle.includes('west')) right = center.x + (center.x - left)
    if (input.handle.includes('east')) left = center.x - (right - center.x)
    if (input.handle.includes('north')) bottom = center.y + (center.y - top)
    if (input.handle.includes('south')) top = center.y - (bottom - center.y)
  }

  if (right - left < MIN_TRANSFORM_SIZE) {
    if (input.handle.includes('west')) left = right - MIN_TRANSFORM_SIZE
    else right = left + MIN_TRANSFORM_SIZE
  }
  if (bottom - top < MIN_TRANSFORM_SIZE) {
    if (input.handle.includes('north')) top = bottom - MIN_TRANSFORM_SIZE
    else bottom = top + MIN_TRANSFORM_SIZE
  }

  if (input.lockAspectRatio) {
    const ratio = Math.max(start.width, 1) / Math.max(start.height, 1)
    let width = right - left
    let height = bottom - top
    const horizontalOnly = input.handle === 'east' || input.handle === 'west'
    const verticalOnly = input.handle === 'north' || input.handle === 'south'
    if (horizontalOnly) height = width / ratio
    else if (verticalOnly) width = height * ratio
    else if (Math.abs(width / Math.max(start.width, 1) - 1)
      >= Math.abs(height / Math.max(start.height, 1) - 1)) {
      height = width / ratio
    } else {
      width = height * ratio
    }
    if (input.handle.includes('west')) left = right - width
    else if (input.handle.includes('east')) right = left + width
    else {
      left = center.x - width / 2
      right = center.x + width / 2
    }
    if (input.handle.includes('north')) top = bottom - height
    else if (input.handle.includes('south')) bottom = top + height
    else {
      top = center.y - height / 2
      bottom = center.y + height / 2
    }
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

function resizeWhiteboardElement(
  element: WhiteboardElement,
  before: WhiteboardBounds,
  after: WhiteboardBounds,
): WhiteboardElement {
  const mapPoint = (point: WhiteboardPoint) => ({
    x: mapCoordinate(point.x, before.x, before.width, after.x, after.width),
    y: mapCoordinate(point.y, before.y, before.height, after.y, after.height),
  })
  const scaleX = after.width / Math.max(before.width, 1)
  const scaleY = after.height / Math.max(before.height, 1)

  switch (element.kind) {
    case 'rectangle':
    case 'image': {
      const center = mapPoint(getWhiteboardElementCenter(element))
      const width = Math.max(MIN_TRANSFORM_SIZE, element.width * scaleX)
      const height = Math.max(MIN_TRANSFORM_SIZE, element.height * scaleY)
      return {
        ...element,
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
      }
    }
    case 'text': {
      const point = mapPoint({ x: element.x, y: element.y })
      const fontScale = Math.sqrt(Math.max(0.04, scaleX * scaleY))
      return {
        ...element,
        ...point,
        fontSize: Math.max(8, (element.fontSize ?? 22) * fontScale),
      }
    }
    case 'stroke':
      return { ...element, points: element.points.map(mapPoint) }
    case 'connector':
      return {
        ...element,
        start: mapPoint(element.start),
        end: mapPoint(element.end),
      }
  }
}

function rotateWhiteboardElement(
  element: WhiteboardElement,
  origin: WhiteboardPoint,
  delta: number,
): WhiteboardElement {
  switch (element.kind) {
    case 'rectangle':
    case 'image': {
      const center = rotateWhiteboardPoint(getWhiteboardElementCenter(element), origin, delta)
      return {
        ...element,
        x: center.x - element.width / 2,
        y: center.y - element.height / 2,
        rotation: normalizeRotation((element.rotation ?? 0) + delta),
      }
    }
    case 'text': {
      const point = rotateWhiteboardPoint({ x: element.x, y: element.y }, origin, delta)
      return {
        ...element,
        ...point,
        rotation: normalizeRotation((element.rotation ?? 0) + delta),
      }
    }
    case 'stroke':
      return {
        ...element,
        points: element.points.map((point) => rotateWhiteboardPoint(point, origin, delta)),
      }
    case 'connector':
      return {
        ...element,
        start: rotateWhiteboardPoint(element.start, origin, delta),
        end: rotateWhiteboardPoint(element.end, origin, delta),
      }
  }
}

function mapCoordinate(
  value: number,
  beforeStart: number,
  beforeSize: number,
  afterStart: number,
  afterSize: number,
) {
  if (beforeSize < 0.001) return afterStart + afterSize / 2
  return afterStart + ((value - beforeStart) / beforeSize) * afterSize
}

function getBoundsCenter(bounds: WhiteboardBounds): WhiteboardPoint {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
}

export function unionWhiteboardBounds(bounds: readonly WhiteboardBounds[]): WhiteboardBounds {
  const minX = Math.min(...bounds.map((item) => item.x))
  const minY = Math.min(...bounds.map((item) => item.y))
  const maxX = Math.max(...bounds.map((item) => item.x + item.width))
  const maxY = Math.max(...bounds.map((item) => item.y + item.height))
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function boundsForPoints(points: readonly WhiteboardPoint[]): WhiteboardBounds {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function normalizeRotation(rotation: number) {
  const normalized = rotation % 360
  return normalized < 0 ? normalized + 360 : normalized
}
