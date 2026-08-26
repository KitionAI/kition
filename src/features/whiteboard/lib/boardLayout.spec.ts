import { describe, expect, it } from 'vitest'

import { alignBoardElements, distributeBoardElements } from './boardLayout'
import type { WhiteboardElement } from './whiteboardTypes'

const ELEMENTS: WhiteboardElement[] = [
  { id: 'one', kind: 'rectangle', x: 10, y: 20, width: 80, height: 40 },
  { id: 'two', kind: 'rectangle', x: 170, y: 80, width: 60, height: 60 },
  { id: 'three', kind: 'rectangle', x: 300, y: 160, width: 100, height: 80 },
]

describe('boardLayout', () => {
  it('aligns mixed-size elements against the selection bounds', () => {
    expect(alignBoardElements(ELEMENTS, 'center-horizontal')).toEqual([
      expect.objectContaining({ id: 'one', x: 165 }),
      expect.objectContaining({ id: 'two', x: 175 }),
      expect.objectContaining({ id: 'three', x: 155 }),
    ])
    expect(alignBoardElements(ELEMENTS, 'bottom')).toEqual([
      expect.objectContaining({ id: 'one', y: 200 }),
      expect.objectContaining({ id: 'two', y: 180 }),
      expect.objectContaining({ id: 'three', y: 160 }),
    ])
  })

  it('distributes three elements with deterministic equal gaps', () => {
    expect(distributeBoardElements(ELEMENTS, 'horizontal')).toEqual([
      expect.objectContaining({ id: 'one', x: 10 }),
      expect.objectContaining({ id: 'two', x: 165 }),
      expect.objectContaining({ id: 'three', x: 300 }),
    ])
  })
})
