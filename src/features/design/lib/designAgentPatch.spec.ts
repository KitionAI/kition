import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import type { AgentDesignPatch } from '@/types/designAgent'
import { applyDesignAgentPatch, parseDesignAgentPatch, reduceDesignAgentPatch } from './designAgentPatch'
import { selectionBounds } from './designGeometry'
import { DesignStore } from './designStore'
import { createDesign, createDesignNode, type DesignDocument } from './designTypes'

function fixture(): DesignDocument {
  const doc = createDesign('Patch me', 1000, 1000)
  const nodes = [
    createDesignNode('text', { id: 'headline', text: 'Old', transform: [1, 0, 0, 1, 100, 100], width: 400, height: 100 }),
    createDesignNode('rectangle', { id: 'box', transform: [1, 0, 0, 1, 100, 300], width: 200, height: 200 }),
    createDesignNode('rectangle', { id: 'box2', transform: [1, 0, 0, 1, 500, 300], width: 200, height: 200 }),
    createDesignNode('rectangle', { id: 'sealed', locked: true }),
  ]
  for (const node of nodes) {
    doc.nodes[node.id] = node
    doc.pages[0].children.push(node.id)
  }
  return doc
}

const patch: AgentDesignPatch = {
  type: 'design.patch',
  schema_version: 1,
  summary: 'Rewrite the headline, restyle the boxes, and add a caption.',
  operations: [
    { op: 'text.set', layer_id: 'headline', text: 'New headline' },
    { op: 'style.set', layer_ids: ['box', 'box2'], style: { fill: '#ff8800', radius: 24, opacity: 0.5 } },
    {
      op: 'layer.create',
      layer: {
        id: 'caption',
        kind: 'text',
        bounds: { x: 100, y: 800, width: 800, height: 60 },
        text: 'A caption',
        style: { font_size: 24, text_align: 'center' },
      },
    },
    { op: 'layer.move', layer_ids: ['headline'], delta: { x: 50, y: -20 } },
    { op: 'layer.resize', layer_id: 'box', bounds: { x: 0, y: 0, width: 300, height: 100 } },
    { op: 'layer.reorder', layer_id: 'box2', direction: 'backward' },
    { op: 'layout.align', layer_ids: ['headline', 'caption'], edge: 'right', reference: 'artboard' },
    { op: 'layout.distribute', layer_ids: ['box', 'box2', 'caption'], axis: 'y' },
    { op: 'artboard.background', background: '#101010' },
    { op: 'layer.delete', layer_ids: ['box2'] },
  ],
}

describe('design agent patches', () => {
  it('matches the public contract and parses through the client schema', () => {
    expectMatchesContract(patch, 'agent-design', 'patch')
    expect(parseDesignAgentPatch(patch)).toEqual({ ok: true, patch })
    expect(parseDesignAgentPatch({ ...patch, operations: [] })).toMatchObject({ ok: false })
    expect(parseDesignAgentPatch({ ...patch, operations: [{ op: 'image.create', layer_id: 'x' }] })).toMatchObject({ ok: false })
    const bad = parseDesignAgentPatch({ ...patch, operations: [{ op: 'style.set', layer_ids: ['box'], style: {} }] })
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('style') })
  })

  it('applies every operation in order into the document', () => {
    const doc = reduceDesignAgentPatch(fixture(), patch)
    expect(doc.nodes.headline.text).toBe('New headline')
    expect(doc.nodes.box).toMatchObject({ fill: '#ff8800', radius: 24, opacity: 0.5, width: 300, height: 100 })
    expect(doc.nodes.caption).toMatchObject({ type: 'text', text: 'A caption', fontSize: 24, textAlign: 'center' })
    // Moved by the delta, then aligned to the artboard's right edge.
    expect(selectionBounds(doc, ['headline'])).toMatchObject({ x: 600, y: 80 })
    expect(selectionBounds(doc, ['caption']).x + 800).toBe(1000)
    expect(doc.pages[0].background).toBe('#101010')
    expect(doc.nodes.box2).toBeUndefined()
    expect(doc.pages[0].children).toEqual(['headline', 'box', 'sealed', 'caption'])
  })

  it('rejects unknown, locked, and mistyped layers without touching the store', () => {
    const store = new DesignStore(fixture())
    const before = store.getSnapshot().document
    const attempt = (operations: AgentDesignPatch['operations']) =>
      () => applyDesignAgentPatch(store, { ...patch, operations })
    expect(attempt([{ op: 'text.set', layer_id: 'ghost', text: 'x' }])).toThrow(/Unknown layer ghost/)
    expect(attempt([{ op: 'layer.delete', layer_ids: ['sealed'] }])).toThrow(/locked/)
    expect(attempt([{ op: 'text.set', layer_id: 'box', text: 'x' }])).toThrow(/not a text layer/)
    expect(attempt([{ op: 'layer.create', layer: { id: 'box', kind: 'rectangle', bounds: { x: 0, y: 0, width: 1, height: 1 } } }])).toThrow(/already exists/)
    expect(store.getSnapshot().document).toBe(before)
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('applies an accepted patch as one undo step', () => {
    const store = new DesignStore(fixture())
    const before = store.getSnapshot().document
    applyDesignAgentPatch(store, patch)
    expect(store.getSnapshot().document.nodes.headline.text).toBe('New headline')
    expect(store.getSnapshot().document.nodes.caption).toBeDefined()
    store.undo()
    expect(store.getSnapshot().document.nodes).toEqual(before.nodes)
    expect(store.getSnapshot().document.pages[0].background).toBe('#ffffff')
    expect(store.getSnapshot().canUndo).toBe(false)
  })
})
