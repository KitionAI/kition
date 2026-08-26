import { describe, expect, it } from 'vitest'

import { exportBoardSvg } from './boardExport'
import type { WhiteboardElement } from './whiteboardTypes'

const ELEMENTS: WhiteboardElement[] = [
  {
    id: 'group',
    kind: 'rectangle',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    shapeStyle: 'group',
  },
  {
    id: 'diamond',
    kind: 'rectangle',
    parentId: 'group',
    x: 20,
    y: 30,
    width: 120,
    height: 80,
    shapeType: 'diamond',
    text: 'Plan & review',
    style: { fillColor: 'purple', strokeColor: 'purple' },
  },
  {
    id: 'connector',
    kind: 'connector',
    start: { x: 140, y: 70 },
    end: { x: 220, y: 70 },
  },
  {
    id: 'image',
    kind: 'image',
    x: 220,
    y: 20,
    width: 160,
    height: 100,
    workspacePath: 'Attachments/launch.png',
  },
]

describe('exportBoardSvg', () => {
  it('exports deterministic standalone SVG without application CSS variables', () => {
    const input = {
      elements: ELEMENTS,
      imageHrefs: new Map([['Attachments/launch.png', 'data:image/png;base64,AAAA']]),
      title: 'Launch <Board>',
    }
    const first = exportBoardSvg(input)
    const second = exportBoardSvg(input)

    expect(first).toBe(second)
    expect(first).toContain('<title>Launch &lt;Board&gt;</title>')
    expect(first).toContain('fill="#e6e0f5"')
    expect(first).toContain('Plan &amp;</tspan>')
    expect(first).toContain('>review</tspan>')
    expect(first).toContain('marker-end="url(#kition-arrow)"')
    expect(first).toContain('href="data:image/png;base64,AAAA"')
    expect(first).not.toContain('var(--')
    expect(first).not.toContain('id="group"')
  })

  it('returns an empty string for an empty Board', () => {
    expect(exportBoardSvg({ elements: [], title: 'Empty' })).toBe('')
  })
})
