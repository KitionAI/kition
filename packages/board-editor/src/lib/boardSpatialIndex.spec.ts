import { describe, expect, it } from 'vitest'

import { BoardSpatialIndex } from './boardSpatialIndex'
import type { WhiteboardElement } from './whiteboardTypes'

describe('BoardSpatialIndex', () => {
  it('returns intersecting elements in Board order', () => {
    const index = new BoardSpatialIndex(100)
    index.sync([
      rectangle('one', 20, 20),
      rectangle('two', 140, 20),
      rectangle('three', 600, 600),
    ])

    expect(index.query({ x: 0, y: 0, width: 300, height: 200 }).map((element) => element.id))
      .toEqual(['one', 'two'])
    expect(index.queryPoint({ x: 160, y: 40 }).map((element) => element.id))
      .toEqual(['two'])
  })

  it('updates moved elements and removes stale entries incrementally', () => {
    const index = new BoardSpatialIndex(100)
    index.sync([rectangle('one', 20, 20), rectangle('two', 140, 20)])
    index.sync([rectangle('one', 500, 500)])

    expect(index.size).toBe(1)
    expect(index.query({ x: 0, y: 0, width: 300, height: 200 })).toEqual([])
    expect(index.query({ x: 450, y: 450, width: 200, height: 200 }).map((element) => element.id))
      .toEqual(['one'])
  })

  it('keeps very large elements queryable without filling every grid cell', () => {
    const index = new BoardSpatialIndex(10)
    index.sync([{
      id: 'large',
      kind: 'rectangle',
      x: -10000,
      y: -10000,
      width: 20000,
      height: 20000,
    }])

    expect(index.queryPoint({ x: 9000, y: 9000 }).map((element) => element.id))
      .toEqual(['large'])
  })

  it('indexes 10,000 elements and returns only the queried viewport window', () => {
    const index = new BoardSpatialIndex(256)
    index.sync(Array.from({ length: 10_000 }, (_, itemIndex) => (
      rectangle(`node-${itemIndex}`, (itemIndex % 100) * 120, Math.floor(itemIndex / 100) * 90)
    )))

    const visible = index.query({ x: 0, y: 0, width: 240, height: 180 })
    expect(index.size).toBe(10_000)
    expect(visible.map((element) => element.id)).toEqual([
      'node-0',
      'node-1',
      'node-2',
      'node-100',
      'node-101',
      'node-102',
      'node-200',
      'node-201',
      'node-202',
    ])
  })
})

function rectangle(id: string, x: number, y: number): WhiteboardElement {
  return { id, kind: 'rectangle', x, y, width: 80, height: 60 }
}
