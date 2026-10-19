import { describe, expect, it } from 'vitest'
import { boardFrameSnapshot } from './boardFrameExport'
import type { WhiteboardElement } from './whiteboardTypes'

const elements: WhiteboardElement[] = [
  { id: 'frame', kind: 'rectangle', x: 100, y: 100, width: 800, height: 600, shapeStyle: 'frame', text: 'Launch' },
  { id: 'card', kind: 'rectangle', x: 140, y: 160, width: 200, height: 100, text: 'Plan', parentId: 'frame', style: { fillColor: 'purple', strokeColor: 'ink' } },
  { id: 'note', kind: 'text', x: 150, y: 300, text: 'Notes', fontSize: 20, parentId: 'frame' },
  { id: 'photo', kind: 'image', x: 500, y: 200, width: 200, height: 150, workspacePath: 'Agent/images/1.png', parentId: 'frame' },
  { id: 'line', kind: 'connector', start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, parentId: 'frame' },
  { id: 'outside', kind: 'rectangle', x: 2000, y: 2000, width: 50, height: 50 },
]

describe('boardFrameSnapshot', () => {
  it('captures frame contents relative to the frame with flat colors', () => {
    const snapshot = boardFrameSnapshot(elements[0], elements)
    expect(snapshot).toMatchObject({ title: 'Launch', width: 800, height: 600 })
    expect(snapshot?.items.map((item) => item.kind)).toEqual(['rectangle', 'text', 'image'])
    expect(snapshot?.items[0]).toMatchObject({ x: 40, y: 60, text: 'Plan', fill: '#5645d4', stroke: '#1a1a1a' })
    expect(snapshot?.items[1]).toMatchObject({ x: 50, y: 200, text: 'Notes', fontSize: 20 })
    expect(snapshot?.items[2]).toMatchObject({ workspacePath: 'Agent/images/1.png' })
  })

  it('returns null for anything that is not a frame', () => {
    expect(boardFrameSnapshot(elements[1], elements)).toBeNull()
  })
})
