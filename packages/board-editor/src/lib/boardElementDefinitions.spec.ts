import { describe, expect, it } from 'vitest'

import {
  WHITEBOARD_PALETTE_SHAPE_TYPES,
  getBoardAgentElementKind,
  getBoardElementSemanticStyle,
  getBoardElementUnrotatedBounds,
  getBoardRectangleDefaultSize,
  getBoardShapeDefinition,
} from './boardElementDefinitions'

describe('Board element definitions', () => {
  it('keeps the palette ordered and free of duplicate shape definitions', () => {
    expect(new Set(WHITEBOARD_PALETTE_SHAPE_TYPES).size)
      .toBe(WHITEBOARD_PALETTE_SHAPE_TYPES.length)
    expect(WHITEBOARD_PALETTE_SHAPE_TYPES).toContain('x-box')
    expect(WHITEBOARD_PALETTE_SHAPE_TYPES).toContain('check-box')
    expect(WHITEBOARD_PALETTE_SHAPE_TYPES).not.toContain('check')
    expect(WHITEBOARD_PALETTE_SHAPE_TYPES.at(-1)).toBe('frame')
  })

  it('centralizes fill, label, and placement behavior', () => {
    expect(getBoardShapeDefinition('line')).toMatchObject({
      supportsFill: false,
      supportsLabel: false,
      defaultSize: { width: 160, height: 32 },
    })
    expect(getBoardRectangleDefaultSize({ shapeStyle: 'sticky' }))
      .toEqual({ width: 180, height: 140 })
    expect(getBoardRectangleDefaultSize({ shapeType: 'diamond' }))
      .toEqual({ width: 160, height: 100 })
  })

  it('provides geometry and Agent semantics through one definition boundary', () => {
    const frame = {
      id: 'frame-1',
      kind: 'rectangle' as const,
      x: 10,
      y: 20,
      width: 300,
      height: 180,
      shapeType: 'frame' as const,
    }
    expect(getBoardElementUnrotatedBounds(frame)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 180,
    })
    expect(getBoardAgentElementKind(frame)).toBe('frame')
    expect(getBoardElementSemanticStyle(frame)).toMatchObject({
      fillStyle: 'none',
      dashStyle: 'dashed',
    })
  })

  it('keeps non-rectangle bounds behavior stable', () => {
    expect(getBoardElementUnrotatedBounds({
      id: 'text-1',
      kind: 'text',
      x: 30,
      y: 60,
      text: 'Hello',
      fontSize: 20,
    })).toEqual({
      x: 30,
      y: 40,
      width: 72,
      height: 28,
    })
    expect(getBoardElementUnrotatedBounds({
      id: 'stroke-1',
      kind: 'stroke',
      points: [{ x: -5, y: 10 }, { x: 15, y: 35 }],
    })).toEqual({ x: -5, y: 10, width: 20, height: 25 })
  })
})
