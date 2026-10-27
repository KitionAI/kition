import { describe, expect, it } from 'vitest'

import { kitBrandProblems } from './kitBrands.mjs'

const palette = {
  $comment: 'generated',
  photo: { kitId: 'kit.photo', light: '#087fa1', dark: '#4ccbf0' },
  design: { kitId: 'kit.design', light: '#d32f8d', dark: '#f57bbd' },
}

describe('kitBrandProblems', () => {
  it('accepts a kit whose brand matches the palette', () => {
    expect(kitBrandProblems(palette, [{ source: 'photo-ui', kitId: 'kit.photo', brand: { light: '#087fa1', dark: '#4ccbf0' } }])).toEqual([])
  })

  it('compares hex colors without regard to case', () => {
    expect(kitBrandProblems(palette, [{ source: 'photo-ui', kitId: 'kit.photo', brand: { light: '#087FA1', dark: '#4CCBF0' } }])).toEqual([])
  })

  it('finds a kit by its kit id', () => {
    expect(kitBrandProblems(palette, [{ source: 'design-ui', kitId: 'kit.design', brand: { light: '#d32f8d', dark: '#f57bbd' } }])).toEqual([])
  })

  it('reports a missing or different brand', () => {
    expect(kitBrandProblems(palette, [
      { source: 'photo-ui', kitId: 'kit.photo', brand: undefined },
      { source: 'design-ui', kitId: 'kit.design', brand: { light: '#000000', dark: '#f57bbd' } },
    ])).toEqual([
      'photo-ui: kit.photo declares no ui.brand; the palette has {"light":"#087fa1","dark":"#4ccbf0"}',
      'design-ui: kit.design declares {"light":"#000000","dark":"#f57bbd"}; the palette has {"light":"#d32f8d","dark":"#f57bbd"}',
    ])
  })

  it('reports a kit the palette does not know', () => {
    expect(kitBrandProblems(palette, [{ source: 'x-ui', kitId: 'kit.x', brand: { light: '#000000', dark: '#ffffff' } }]))
      .toEqual(['x-ui: kit.x has no entry in kits/kit-colors.json (scripts/brand/kit_icons.py)'])
  })
})
