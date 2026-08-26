import {
  getWhiteboardElementBounds,
  getWhiteboardSelectionBounds,
} from './whiteboardGeometry'
import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardResizeHandle,
} from './whiteboardTypes'

export type BoardSnapGuide = {
  axis: 'x' | 'y'
  position: number
  start: number
  end: number
}

export function getBoardTranslationSnap(input: {
  movingElements: readonly WhiteboardElement[]
  stationaryElements: readonly WhiteboardElement[]
  threshold: number
}): {
  adjustment: WhiteboardPoint
  guides: BoardSnapGuide[]
} {
  const movingBounds = getWhiteboardSelectionBounds(input.movingElements)
  if (!movingBounds || input.stationaryElements.length === 0) {
    return { adjustment: { x: 0, y: 0 }, guides: [] }
  }

  const targetBounds = input.stationaryElements.map(getWhiteboardElementBounds)
  const xSnap = findAxisSnap(
    axisPositions(movingBounds, 'x'),
    targetBounds,
    'x',
    input.threshold,
  ) || findEqualGapSnap(movingBounds, targetBounds, 'x', input.threshold)
  const ySnap = findAxisSnap(
    axisPositions(movingBounds, 'y'),
    targetBounds,
    'y',
    input.threshold,
  ) || findEqualGapSnap(movingBounds, targetBounds, 'y', input.threshold)
  const adjustedBounds = {
    ...movingBounds,
    x: movingBounds.x + (xSnap?.delta || 0),
    y: movingBounds.y + (ySnap?.delta || 0),
  }
  const guides: BoardSnapGuide[] = []
  if (xSnap) {
    guides.push({
      axis: 'x',
      position: xSnap.position,
      start: Math.min(adjustedBounds.y, xSnap.targetBounds.y),
      end: Math.max(
        adjustedBounds.y + adjustedBounds.height,
        xSnap.targetBounds.y + xSnap.targetBounds.height,
      ),
    })
  }
  if (ySnap) {
    guides.push({
      axis: 'y',
      position: ySnap.position,
      start: Math.min(adjustedBounds.x, ySnap.targetBounds.x),
      end: Math.max(
        adjustedBounds.x + adjustedBounds.width,
        ySnap.targetBounds.x + ySnap.targetBounds.width,
      ),
    })
  }
  return {
    adjustment: {
      x: xSnap?.delta || 0,
      y: ySnap?.delta || 0,
    },
    guides,
  }
}

export function getBoardResizeSnap(input: {
  handle: WhiteboardResizeHandle
  point: WhiteboardPoint
  selectionBounds: WhiteboardBounds
  stationaryElements: readonly WhiteboardElement[]
  threshold: number
}): {
  guides: BoardSnapGuide[]
  point: WhiteboardPoint
} {
  const targetBounds = input.stationaryElements.map(getWhiteboardElementBounds)
  const point = { ...input.point }
  const guides: BoardSnapGuide[] = []
  if (input.handle.includes('west') || input.handle.includes('east')) {
    const snap = findAxisSnap([input.point.x], targetBounds, 'x', input.threshold)
    if (snap) {
      point.x += snap.delta
      guides.push({
        axis: 'x',
        position: snap.position,
        start: Math.min(input.selectionBounds.y, snap.targetBounds.y),
        end: Math.max(
          input.selectionBounds.y + input.selectionBounds.height,
          snap.targetBounds.y + snap.targetBounds.height,
        ),
      })
    }
  }
  if (input.handle.includes('north') || input.handle.includes('south')) {
    const snap = findAxisSnap([input.point.y], targetBounds, 'y', input.threshold)
    if (snap) {
      point.y += snap.delta
      guides.push({
        axis: 'y',
        position: snap.position,
        start: Math.min(input.selectionBounds.x, snap.targetBounds.x),
        end: Math.max(
          input.selectionBounds.x + input.selectionBounds.width,
          snap.targetBounds.x + snap.targetBounds.width,
        ),
      })
    }
  }
  return { guides, point }
}

function findAxisSnap(
  movingPositions: readonly number[],
  targetBounds: readonly WhiteboardBounds[],
  axis: 'x' | 'y',
  threshold: number,
) {
  let best: {
    delta: number
    position: number
    targetBounds: WhiteboardBounds
  } | null = null
  for (const bounds of targetBounds) {
    for (const targetPosition of axisPositions(bounds, axis)) {
      for (const movingPosition of movingPositions) {
        const delta = targetPosition - movingPosition
        if (Math.abs(delta) > threshold) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, position: targetPosition, targetBounds: bounds }
        }
      }
    }
  }
  return best
}

function findEqualGapSnap(
  movingBounds: WhiteboardBounds,
  targetBounds: readonly WhiteboardBounds[],
  axis: 'x' | 'y',
  threshold: number,
) {
  const sizeKey = axis === 'x' ? 'width' : 'height'
  const movingStart = movingBounds[axis]
  const movingEnd = movingStart + movingBounds[sizeKey]
  const before = targetBounds.filter((bounds) => (
    bounds[axis] + bounds[sizeKey] <= movingStart + threshold
  ))
  const after = targetBounds.filter((bounds) => (
    bounds[axis] >= movingEnd - threshold
  ))
  let best: ReturnType<typeof buildEqualGapSnap> | null = null
  for (const left of before) {
    for (const right of after) {
      const candidate = buildEqualGapSnap(movingBounds, left, right, axis)
      if (Math.abs(candidate.delta) > threshold) continue
      if (!best || Math.abs(candidate.delta) < Math.abs(best.delta)) best = candidate
    }
  }
  return best
}

function buildEqualGapSnap(
  movingBounds: WhiteboardBounds,
  before: WhiteboardBounds,
  after: WhiteboardBounds,
  axis: 'x' | 'y',
) {
  const sizeKey = axis === 'x' ? 'width' : 'height'
  const beforeEnd = before[axis] + before[sizeKey]
  const targetStart = (beforeEnd + after[axis] - movingBounds[sizeKey]) / 2
  return {
    delta: targetStart - movingBounds[axis],
    position: targetStart + movingBounds[sizeKey] / 2,
    targetBounds: unionSnapBounds(before, after),
  }
}

function unionSnapBounds(left: WhiteboardBounds, right: WhiteboardBounds) {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  }
}

function axisPositions(bounds: WhiteboardBounds, axis: 'x' | 'y') {
  const start = bounds[axis]
  const size = axis === 'x' ? bounds.width : bounds.height
  return [start, start + size / 2, start + size]
}
