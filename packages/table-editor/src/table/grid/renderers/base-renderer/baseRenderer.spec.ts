import { describe, expect, it, vi } from 'vitest'

import { drawCheckbox } from './baseRenderer'

describe('drawCheckbox', () => {
  it('uses the fill color for a checked border and reserves white for the check mark', () => {
    const strokeColors: string[] = []
    const context = {
      arcTo: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      set fillStyle(_value: string) {},
      set lineCap(_value: CanvasLineCap) {},
      set lineJoin(_value: CanvasLineJoin) {},
      set lineWidth(_value: number) {},
      set strokeStyle(value: string) {
        strokeColors.push(value)
      },
    } as unknown as CanvasRenderingContext2D

    drawCheckbox(context, {
      x: 0,
      y: 0,
      size: 20,
      fill: '#5645d4',
      stroke: '#ffffff',
      isChecked: true,
    })

    expect(strokeColors).toEqual(['#5645d4', '#ffffff'])
  })
})
