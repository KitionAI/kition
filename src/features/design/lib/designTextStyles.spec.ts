import { describe, expect, it } from 'vitest'
import { applyDesignCommand } from './designCommands'
import { parseDesign, serializeDesign } from './designSerialization'
import { DesignStore } from './designStore'
import { createDesign, createDesignNode, type DesignDocument, type DesignTextStyle } from './designTypes'

const heading: DesignTextStyle = {
  id: 'heading',
  name: 'Heading',
  fontFamily: 'Lora',
  fontSize: 120,
  fontWeight: 700,
  lineHeight: 1.1,
  letterSpacing: -2,
  fill: '#101010',
}

function fixture(): DesignDocument {
  const doc = createDesign('Styles')
  for (const id of ['a', 'b']) {
    doc.nodes[id] = createDesignNode('text', { id, text: id, fontSize: 40 })
    doc.pages[0].children.push(id)
  }
  doc.nodes.shape = createDesignNode('rectangle', { id: 'shape' })
  doc.pages[0].children.push('shape')
  return doc
}

describe('text styles', () => {
  it('defines a style and applies its values to text layers only', () => {
    let doc = applyDesignCommand(fixture(), { type: 'textStyle', style: heading })
    doc = applyDesignCommand(doc, { type: 'applyTextStyle', ids: ['a', 'shape'], styleId: 'heading' })
    expect(doc.textStyles).toEqual({ heading })
    expect(doc.nodes.a).toMatchObject({ styleId: 'heading', fontFamily: 'Lora', fontSize: 120, letterSpacing: -2, fill: '#101010' })
    expect(doc.nodes.b.fontSize).toBe(40)
    expect(doc.nodes.shape.styleId).toBeUndefined()
    expect(doc.nodes.shape.fontSize).toBe(80)
  })

  it('updates every follower when the style changes and detaches on a local edit', () => {
    let doc = applyDesignCommand(fixture(), { type: 'textStyle', style: heading })
    doc = applyDesignCommand(doc, { type: 'applyTextStyle', ids: ['a', 'b'], styleId: 'heading' })
    doc = applyDesignCommand(doc, { type: 'patch', ids: ['b'], patch: { fontSize: 64 } })
    expect(doc.nodes.b).toMatchObject({ fontSize: 64, fontFamily: 'Lora' })
    expect(doc.nodes.b.styleId).toBeUndefined()
    doc = applyDesignCommand(doc, { type: 'patch', ids: ['a'], patch: { text: 'Still styled', opacity: 0.5 } })
    expect(doc.nodes.a.styleId).toBe('heading')
    doc = applyDesignCommand(doc, { type: 'textStyle', style: { ...heading, fontFamily: 'Inter', fontSize: 96 } })
    expect(doc.nodes.a).toMatchObject({ fontFamily: 'Inter', fontSize: 96 })
    expect(doc.nodes.b).toMatchObject({ fontFamily: 'Lora', fontSize: 64 })
  })

  it('detaches explicitly or when the style is removed, keeping current values', () => {
    let doc = applyDesignCommand(fixture(), { type: 'textStyle', style: heading })
    doc = applyDesignCommand(doc, { type: 'applyTextStyle', ids: ['a', 'b'], styleId: 'heading' })
    doc = applyDesignCommand(doc, { type: 'applyTextStyle', ids: ['a'], styleId: null })
    expect(doc.nodes.a.styleId).toBeUndefined()
    expect(doc.nodes.a.fontFamily).toBe('Lora')
    doc = applyDesignCommand(doc, { type: 'removeTextStyle', id: 'heading' })
    expect(doc.textStyles).toEqual({})
    expect(doc.nodes.b.styleId).toBeUndefined()
    expect(doc.nodes.b.fontSize).toBe(120)
    expect(applyDesignCommand(doc, { type: 'applyTextStyle', ids: ['a'], styleId: 'missing' }).nodes.a.styleId).toBeUndefined()
  })

  it('undoes style definitions together with their followers and survives a save', () => {
    const store = new DesignStore(fixture())
    store.execute({ type: 'textStyle', style: heading })
    store.execute({ type: 'applyTextStyle', ids: ['a'], styleId: 'heading' })
    const saved = parseDesign(serializeDesign(store.getSnapshot().document))
    expect(saved.textStyles).toEqual({ heading })
    expect(saved.nodes.a.styleId).toBe('heading')
    store.undo()
    store.undo()
    expect(store.getSnapshot().document.textStyles).toBeUndefined()
    expect(store.getSnapshot().document.nodes.a.styleId).toBeUndefined()
    // Files written before text styles existed still open.
    const legacy = fixture()
    delete legacy.textStyles
    expect(parseDesign(serializeDesign(legacy)).textStyles).toBeUndefined()
  })
})
