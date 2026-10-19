import { describe, expect, it } from 'vitest'

import { lintWhiteboard } from './whiteboardLint'

describe('lintWhiteboard', () => {
  it('reports semantic nodes without labels or connector bindings', () => {
    expect(lintWhiteboard({
      elements: [{
        id: 'node', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60,
        shapeStyle: 'flow-node',
      }],
    })).toEqual([
      expect.objectContaining({ code: 'missing-label', elementIds: ['node'] }),
      expect.objectContaining({ code: 'disconnected-node', elementIds: ['node'] }),
    ])
  })

  it('reports children outside frames and overlapping text labels', () => {
    const findings = lintWhiteboard({ elements: [
      { id: 'frame', kind: 'rectangle', x: 0, y: 0, width: 200, height: 160, shapeStyle: 'frame' },
      { id: 'outside', kind: 'rectangle', parentId: 'frame', x: 180, y: 20, width: 80, height: 60 },
      { id: 'label-a', kind: 'text', x: 20, y: 40, text: 'Alpha' },
      { id: 'label-b', kind: 'text', x: 22, y: 40, text: 'Beta' },
    ] })
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'outside-frame', elementIds: ['outside', 'frame'] }),
      expect.objectContaining({ code: 'overlapping-label', elementIds: ['label-a', 'label-b'] }),
    ]))
  })
})
