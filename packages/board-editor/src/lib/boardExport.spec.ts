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

  it('exports legacy mind-map branches with presentation geometry', () => {
    const svg = exportBoardSvg({
      elements: [{
        id: 'branch',
        kind: 'connector',
        connectorRole: 'mind-map-branch',
        start: { x: 20, y: 20 },
        end: { x: 40, y: 40 },
      }],
      mindMapBranchAxisByConnectorId: new Map([['branch', 'horizontal']]),
      mindMapBranchTerminalsByConnectorId: new Map([['branch', {
        start: { x: 100, y: 80 },
        end: { x: 300, y: 220 },
      }]]),
      title: 'Mind map',
    })

    expect(svg).toContain('d="M 100 80 C 190 80 210 220 300 220"')
  })
})
