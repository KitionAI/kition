import { describe, expect, it } from 'vitest'
import { applyDesignCommand } from '../lib/designCommands'
import { createDesign, createDesignNode } from '../lib/designTypes'
import { designLayerRows, designLayerWindow } from './DesignLayers'

describe('layer list windowing', () => {
  it('lists layers top of stack first with nesting depth', () => {
    const doc = createDesign('Rows')
    for (const id of ['a', 'b', 'c']) {
      doc.nodes[id] = createDesignNode('rectangle', { id })
      doc.pages[0].children.push(id)
    }
    const grouped = applyDesignCommand(doc, { type: 'group', ids: ['a', 'b'] })
    const rows = designLayerRows(grouped)
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 1])
    expect(rows[0].id).toBe('c')
    expect(rows.slice(2).map((row) => row.id)).toEqual(['b', 'a'])
  })

  it('renders only the rows around the viewport', () => {
    expect(designLayerWindow(2000, 0, 600)).toEqual({ start: 0, end: 25, top: 0, bottom: (2000 - 25) * 36 })
    const middle = designLayerWindow(2000, 36 * 1000, 600)
    expect(middle.start).toBe(992)
    expect(middle.end).toBe(1025)
    expect(middle.top).toBe(992 * 36)
    expect(designLayerWindow(10, 0, 600)).toEqual({ start: 0, end: 10, top: 0, bottom: 0 })
  })
})
