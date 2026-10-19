import { describe, expect, it } from 'vitest'

import {
  createBoardClipboardText,
  instantiateBoardClipboardRecords,
  parseBoardClipboardText,
} from './boardClipboard'
import {
  createBoardRecordsFromElements,
  type BoardBindingRecord,
} from './boardRecords'
import type { WhiteboardElement } from './whiteboardTypes'

describe('boardClipboard', () => {
  it('copies descendants and internal bindings, then remaps every relationship', () => {
    const elements: WhiteboardElement[] = [
      {
        id: 'frame',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        shapeType: 'frame',
      },
      {
        id: 'child',
        kind: 'rectangle',
        parentId: 'frame',
        x: 40,
        y: 60,
        width: 100,
        height: 80,
      },
      {
        id: 'connector',
        kind: 'connector',
        parentId: 'frame',
        start: { x: 140, y: 100 },
        end: { x: 260, y: 100 },
      },
    ]
    const records = [
      ...createBoardRecordsFromElements(elements),
      {
        record_type: 'binding',
        id: 'binding:connector:start',
        binding_type: 'connector',
        from_id: 'connector',
        to_id: 'child',
        terminal: 'start',
        to_anchor: { x: 1, y: 0.5 },
      } satisfies BoardBindingRecord,
    ]

    const parsed = parseBoardClipboardText(createBoardClipboardText(records, ['frame']))
    expect(parsed).not.toBeNull()
    const pasted = instantiateBoardClipboardRecords(parsed!, { x: 24, y: 36 })
    const frame = pasted.elements.find((element) => (
      element.kind === 'rectangle' && element.shapeType === 'frame'
    ))!
    const child = pasted.elements.find((element) => (
      element.kind === 'rectangle' && element.shapeType !== 'frame'
    ))!
    const connector = pasted.elements.find((element) => element.kind === 'connector')!

    expect(frame).toMatchObject({ x: 24, y: 36 })
    expect(child).toMatchObject({ parentId: frame.id, x: 64, y: 96 })
    expect(connector).toMatchObject({ parentId: frame.id })
    expect(pasted.bindings).toEqual([
      expect.objectContaining({
        from_id: connector.id,
        terminal: 'start',
        to_id: child.id,
      }),
    ])
  })

  it('does not place a host image path on the clipboard', () => {
    const records = createBoardRecordsFromElements([{
      id: 'unsafe-image',
      kind: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      workspacePath: '/Users/alice/private.png',
    }])

    expect(createBoardClipboardText(records, ['unsafe-image'])).toBe('')
  })

  it('rejects unrelated or unsupported clipboard text', () => {
    expect(parseBoardClipboardText('Plain text')).toBeNull()
    expect(parseBoardClipboardText(JSON.stringify({
      format: 'kition-board-clipboard',
      version: 2,
      records: [],
    }))).toBeNull()
  })
})
