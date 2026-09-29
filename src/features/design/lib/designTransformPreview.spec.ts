import { describe, expect, it } from 'vitest'
import { applyDesignCommand } from './designCommands'
import { translation } from './designGeometry'
import { previewDesignTransform } from './designTransformPreview'
import { createDesign, createDesignNode, type Matrix } from './designTypes'

function fixture() {
  return applyDesignCommand(createDesign(), { type: 'insert', nodes: [
    createDesignNode('rectangle', { id: 'shape' }),
    createDesignNode('text', { id: 'label', text: 'Sample' }),
  ] })
}

describe('design transform previews', () => {
  it('moves selected layers without mutating the saved document or copying unchanged layers', () => {
    const source = fixture()
    const snapshot = structuredClone(source)
    const preview = previewDesignTransform(source, ['shape'], translation(20, 30))
    expect(preview).toEqual(applyDesignCommand(source, { type: 'transform', ids: ['shape'], matrix: translation(20, 30) }))
    expect(source).toEqual(snapshot)
    expect(preview.nodes.label).toBe(source.nodes.label)
    expect(preview.assets).toBe(source.assets)
  })

  it('preserves parent-space geometry and applies a selected group only once', () => {
    const grouped = applyDesignCommand(fixture(), { type: 'group', ids: ['shape', 'label'] })
    const groupId = grouped.pages[0].children[0]
    const source = applyDesignCommand(grouped, { type: 'transform', ids: [groupId], matrix: [0, 1, -1, 0, 40, 50] })
    for (const ids of [['shape'], [groupId, 'shape']]) {
      const matrix = translation(20, 30)
      expect(previewDesignTransform(source, ids, matrix)).toEqual(applyDesignCommand(source, { type: 'transform', ids, matrix }))
    }
    const locked = applyDesignCommand(source, { type: 'patch', ids: [groupId], patch: { locked: true } })
    expect(previewDesignTransform(locked, ['shape'], translation(20, 30))).toBe(locked)
  })

  it('rejects invalid transforms before showing a preview and preserves no-op identity', () => {
    const source = fixture()
    expect(previewDesignTransform(source, ['shape'], translation(0, 0))).toBe(source)
    for (const matrix of [[0, 0, 0, 0, 0, 0], [1, 0, 0, 1, Infinity, 0], [1, 0, 0, 1, 1e8, 0]] as Matrix[]) {
      expect(() => previewDesignTransform(source, ['shape'], matrix)).toThrow()
    }
  })
})
