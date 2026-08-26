import { getWhiteboardElementBounds, whiteboardBoundsIntersect } from './whiteboardGeometry'
import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardPoint,
} from './whiteboardTypes'

const DEFAULT_CELL_SIZE = 512
const MAX_CELLS_PER_ELEMENT = 256
const MAX_QUERY_CELLS = 4096

type SpatialEntry = {
  bounds: WhiteboardBounds
  cells: string[]
  element: WhiteboardElement
  large: boolean
  order: number
}

type SpatialCellSpan = {
  count: number
  endX: number
  endY: number
  startX: number
  startY: number
}

export class BoardSpatialIndex {
  private readonly cells = new Map<string, Set<string>>()
  private readonly entries = new Map<string, SpatialEntry>()
  private readonly largeElementIds = new Set<string>()

  constructor(private readonly cellSize = DEFAULT_CELL_SIZE) {}

  sync(elements: readonly WhiteboardElement[]) {
    const presentIds = new Set(elements.map((element) => element.id))
    for (const id of this.entries.keys()) {
      if (!presentIds.has(id)) this.remove(id)
    }
    elements.forEach((element, order) => this.upsert(element, order))
  }

  upsert(element: WhiteboardElement, order = this.entries.size) {
    const bounds = getWhiteboardElementBounds(element)
    const current = this.entries.get(element.id)
    if (current && whiteboardBoundsEqual(current.bounds, bounds)) {
      current.element = element
      current.order = order
      return
    }
    if (current) this.remove(element.id)
    const cellSpan = this.getCellSpan(bounds)
    const large = cellSpan.count > MAX_CELLS_PER_ELEMENT
    const cells = large ? [] : this.getCellKeys(cellSpan)
    const entry: SpatialEntry = {
      bounds,
      cells,
      element,
      large,
      order,
    }
    this.entries.set(element.id, entry)
    if (large) {
      this.largeElementIds.add(element.id)
      return
    }
    for (const key of cells) {
      const ids = this.cells.get(key) || new Set<string>()
      ids.add(element.id)
      this.cells.set(key, ids)
    }
  }

  remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    this.largeElementIds.delete(id)
    for (const key of entry.cells) {
      const ids = this.cells.get(key)
      if (!ids) continue
      ids.delete(id)
      if (ids.size === 0) this.cells.delete(key)
    }
    return true
  }

  query(bounds: WhiteboardBounds) {
    const cellSpan = this.getCellSpan(bounds)
    const candidateIds = new Set<string>(this.largeElementIds)
    if (cellSpan.count > MAX_QUERY_CELLS) {
      for (const id of this.entries.keys()) candidateIds.add(id)
    } else {
      for (const key of this.getCellKeys(cellSpan)) {
        for (const id of this.cells.get(key) || []) candidateIds.add(id)
      }
    }
    return [...candidateIds]
      .flatMap((id) => {
        const entry = this.entries.get(id)
        return entry && whiteboardBoundsIntersect(bounds, entry.bounds) ? [entry] : []
      })
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.element)
  }

  queryPoint(point: WhiteboardPoint, tolerance = 0) {
    const radius = Math.max(0, tolerance)
    return this.query({
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2,
    })
  }

  get size() {
    return this.entries.size
  }

  private getCellSpan(bounds: WhiteboardBounds) {
    const startX = Math.floor(bounds.x / this.cellSize)
    const startY = Math.floor(bounds.y / this.cellSize)
    const endX = Math.floor((bounds.x + Math.max(0, bounds.width)) / this.cellSize)
    const endY = Math.floor((bounds.y + Math.max(0, bounds.height)) / this.cellSize)
    return {
      count: (endX - startX + 1) * (endY - startY + 1),
      endX,
      endY,
      startX,
      startY,
    }
  }

  private getCellKeys(span: SpatialCellSpan) {
    const keys: string[] = []
    for (let x = span.startX; x <= span.endX; x += 1) {
      for (let y = span.startY; y <= span.endY; y += 1) keys.push(`${x}:${y}`)
    }
    return keys
  }
}

function whiteboardBoundsEqual(left: WhiteboardBounds, right: WhiteboardBounds) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
}
