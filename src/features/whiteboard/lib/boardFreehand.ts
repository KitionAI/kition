import type { WhiteboardPoint } from './whiteboardTypes'

export function simplifyBoardFreehandPoints(
  points: readonly WhiteboardPoint[],
  tolerance = 1,
) {
  if (points.length <= 2) return points.map((point) => ({ ...point }))
  const squaredTolerance = Math.max(0, tolerance) ** 2
  const radial = simplifyRadialDistance(points, squaredTolerance)
  return simplifyDouglasPeucker(radial, squaredTolerance)
}

function simplifyRadialDistance(
  points: readonly WhiteboardPoint[],
  squaredTolerance: number,
) {
  const simplified: WhiteboardPoint[] = [{ ...points[0] }]
  let previous = points[0]
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]
    if (squaredDistance(point, previous) <= squaredTolerance) continue
    simplified.push({ ...point })
    previous = point
  }
  const last = points.at(-1)!
  if (previous !== last) simplified.push({ ...last })
  return simplified
}

function simplifyDouglasPeucker(
  points: readonly WhiteboardPoint[],
  squaredTolerance: number,
) {
  if (points.length <= 2) return points.map((point) => ({ ...point }))
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let furthestIndex = 0
    let furthestDistance = squaredTolerance
    for (let index = first + 1; index < last; index += 1) {
      const distance = squaredSegmentDistance(points[index], points[first], points[last])
      if (distance > furthestDistance) {
        furthestDistance = distance
        furthestIndex = index
      }
    }
    if (!furthestIndex) continue
    keep[furthestIndex] = 1
    stack.push([first, furthestIndex], [furthestIndex, last])
  }
  return points.flatMap((point, index) => keep[index] ? [{ ...point }] : [])
}

function squaredDistance(left: WhiteboardPoint, right: WhiteboardPoint) {
  const x = left.x - right.x
  const y = left.y - right.y
  return x * x + y * y
}

function squaredSegmentDistance(
  point: WhiteboardPoint,
  start: WhiteboardPoint,
  end: WhiteboardPoint,
) {
  let x = start.x
  let y = start.y
  const deltaX = end.x - x
  const deltaY = end.y - y
  if (deltaX !== 0 || deltaY !== 0) {
    const ratio = ((point.x - x) * deltaX + (point.y - y) * deltaY)
      / (deltaX * deltaX + deltaY * deltaY)
    if (ratio > 1) {
      x = end.x
      y = end.y
    } else if (ratio > 0) {
      x += deltaX * ratio
      y += deltaY * ratio
    }
  }
  const distanceX = point.x - x
  const distanceY = point.y - y
  return distanceX * distanceX + distanceY * distanceY
}
