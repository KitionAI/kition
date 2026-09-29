import { describe, expect, it } from 'vitest'
import { applyDesignCommand } from './designCommands'
import { selectionBounds } from './designGeometry'
import { validateDesign } from './designSerialization'
import { DesignStore } from './designStore'
import { createDesign, createDesignNode, type DesignDocument } from './designTypes'
import {
  createDesignVariant,
  designVariantList,
  foldDesignVariant,
  removeDesignVariant,
  resolveDesignVariant,
} from './designVariants'

function fixture(): DesignDocument {
  const doc = createDesign('Poster', 1080, 1440)
  doc.nodes.h = createDesignNode('text', {
    id: 'h',
    text: 'Headline',
    transform: [1, 0, 0, 1, 240, 100],
    width: 600,
    height: 80,
    constraints: { horizontal: 'center', vertical: 'top' },
  })
  doc.nodes.r = createDesignNode('rectangle', {
    id: 'r',
    transform: [1, 0, 0, 1, 0, 1240],
    width: 1080,
    height: 200,
    constraints: { horizontal: 'scale', vertical: 'bottom' },
  })
  doc.pages[0].children.push('h', 'r')
  return doc
}

describe('size variants', () => {
  it('creates a story variant that reflows layers by constraints and keeps the base intact', () => {
    const { document, variantId } = createDesignVariant(fixture(), { name: 'Story', width: 1080, height: 1920 })
    expect(document.pages[0]).toMatchObject({ width: 1080, height: 1440 })
    expect(document.variants?.[variantId]).toMatchObject({ name: 'Story', width: 1080, height: 1920 })
    const view = resolveDesignVariant(document, variantId)
    expect(view.pages[0]).toMatchObject({ width: 1080, height: 1920 })
    expect(selectionBounds(view, ['h'])).toMatchObject({ x: 240, y: 100 })
    expect(selectionBounds(view, ['r'])).toMatchObject({ y: 1720, height: 200 })
    expect(document.variants?.[variantId].overrides.h).toBeUndefined()
    expect(document.variants?.[variantId].overrides.r).toBeDefined()
    expect(() => validateDesign(document)).not.toThrow()
    expect(resolveDesignVariant(document, null)).toBe(document)
    expect(resolveDesignVariant(document, 'missing')).toBe(document)
  })

  it('folds edits on a variant: geometry stays per variant, text and style are shared', () => {
    const { document, variantId } = createDesignVariant(fixture(), { name: 'Square', width: 1080, height: 1080 })
    let view = resolveDesignVariant(document, variantId)
    view = applyDesignCommand(view, { type: 'patch', ids: ['h'], patch: { text: 'Shared text', fill: '#ff0000', fontSize: 40 } })
    view = applyDesignCommand(view, { type: 'transform', ids: ['h'], matrix: [1, 0, 0, 1, 0, 300] })
    const folded = foldDesignVariant(document, view, variantId)
    expect(folded.nodes.h).toMatchObject({ text: 'Shared text', fill: '#ff0000', fontSize: 80, transform: [1, 0, 0, 1, 240, 100] })
    expect(folded.variants?.[variantId].overrides.h).toEqual({ transform: [1, 0, 0, 1, 240, 400], fontSize: 40 })
    expect(folded.pages[0].height).toBe(1440)
    const again = resolveDesignVariant(folded, variantId)
    expect(again.nodes.h).toMatchObject({ text: 'Shared text', fontSize: 40, transform: [1, 0, 0, 1, 240, 400] })
  })

  it('adds, removes, and recolors through a variant without losing the shared structure', () => {
    const { document, variantId } = createDesignVariant(fixture(), { name: 'Wide', width: 1920, height: 1080 })
    let view = resolveDesignVariant(document, variantId)
    const extra = createDesignNode('ellipse', { id: 'e', transform: [1, 0, 0, 1, 10, 10], width: 50, height: 50 })
    view = applyDesignCommand(view, { type: 'insert', nodes: [extra] })
    view = applyDesignCommand(view, { type: 'remove', ids: ['r'] })
    view = applyDesignCommand(view, { type: 'page', patch: { background: '#101010' } })
    const folded = foldDesignVariant(document, view, variantId)
    expect(folded.nodes.e).toMatchObject({ type: 'ellipse', width: 50 })
    expect(folded.nodes.r).toBeUndefined()
    expect(folded.variants?.[variantId].overrides.r).toBeUndefined()
    expect(folded.pages[0].background).toBe('#ffffff')
    expect(folded.variants?.[variantId].background).toBe('#101010')
    expect(folded.pages[0].children).toEqual(['h', 'e'])
    expect(designVariantList(folded).map((entry) => entry.name)).toEqual(['', 'Wide'])
    const removed = removeDesignVariant(folded, variantId)
    expect(removed.variants).toEqual({})
    expect(removeDesignVariant(removed, 'missing')).toBe(removed)
  })

  it('edits through the store on a variant and undoes the variant itself', () => {
    const store = new DesignStore(fixture())
    const id = store.addVariant({ name: 'Story', width: 1080, height: 1920 })
    expect(store.getSnapshot().variantId).toBe(id)
    expect(store.getSnapshot().view.pages[0].height).toBe(1920)
    store.execute({ type: 'transform', ids: ['h'], matrix: [1, 0, 0, 1, 0, 500] })
    store.execute({ type: 'patch', ids: ['h'], patch: { text: 'Everywhere' } })
    const snapshot = store.getSnapshot()
    expect(snapshot.document.pages[0].height).toBe(1440)
    expect(snapshot.document.nodes.h).toMatchObject({ text: 'Everywhere', transform: [1, 0, 0, 1, 240, 100] })
    expect(snapshot.document.variants?.[id].overrides.h?.transform).toEqual([1, 0, 0, 1, 240, 600])
    expect(snapshot.view.nodes.h.transform).toEqual([1, 0, 0, 1, 240, 600])
    store.setVariant(null)
    expect(store.getSnapshot().view.nodes.h.transform).toEqual([1, 0, 0, 1, 240, 100])
    store.undo()
    store.undo()
    store.undo()
    expect(Object.keys(store.getSnapshot().document.variants ?? {})).toEqual([])
    expect(store.getSnapshot().variantId).toBeNull()
    store.redo()
    expect(Object.keys(store.getSnapshot().document.variants ?? {})).toEqual([id])
  })
})
