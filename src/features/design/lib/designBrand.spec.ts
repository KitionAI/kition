import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import {
  applyBrandColor,
  applyBrandFont,
  brandKitBindings,
  brandKitContext,
  EMPTY_BRAND_KIT,
  parseBrandKit,
  serializeBrandKit,
} from './designBrand'
import { buildDesignAgentContext } from './designAgentContext'
import { createDesign, createDesignNode, type DesignDocument } from './designTypes'

const kit = parseBrandKit(
  JSON.stringify({
    version: 1,
    name: 'Kition',
    colors: { primary: '#5645d4', text: '#1a1a1a' },
    fontFamily: 'Inter',
    logoPath: 'assets/logo.png',
  }),
)

function fixture(): DesignDocument {
  const doc = createDesign('Brand')
  doc.nodes.h = createDesignNode('text', { id: 'h', text: 'Hi', fontFamily: 'Georgia' })
  doc.nodes.b = createDesignNode('text', { id: 'b', text: 'Body' })
  doc.nodes.r = createDesignNode('rectangle', { id: 'r', fill: '#ff0000' })
  doc.pages[0].children.push('h', 'b', 'r')
  return doc
}

describe('brand kit', () => {
  it('round-trips the file and rejects host paths and unknown fields', () => {
    expect(parseBrandKit(serializeBrandKit(kit))).toEqual(kit)
    expect(() => parseBrandKit(JSON.stringify({ ...kit, logoPath: '/Users/alice/logo.png' }))).toThrow()
    expect(() => parseBrandKit(JSON.stringify({ ...kit, tracking: 'x' }))).toThrow()
    expect(() => parseBrandKit(JSON.stringify({ ...kit, colors: { primary: 'purple' } }))).toThrow()
  })

  it('resolves bindings and the agent summary, omitting empty kits', () => {
    expect(brandKitBindings(kit)).toEqual({ colors: { primary: '#5645d4', text: '#1a1a1a' }, fontFamily: 'Inter' })
    expect(brandKitBindings(EMPTY_BRAND_KIT)).toBeUndefined()
    expect(brandKitBindings(null)).toBeUndefined()
    expect(brandKitContext(kit)).toEqual({ colors: ['#5645d4', '#1a1a1a'], fonts: ['Inter'] })
    expect(brandKitContext(EMPTY_BRAND_KIT)).toBeUndefined()
    const context = buildDesignAgentContext({
      document: fixture(),
      path: 'a.kidesign',
      selection: [],
      brand: brandKitContext(kit),
    })
    expectMatchesContract(context, 'agent-design', 'context')
    expect(context?.brand).toEqual({ colors: ['#5645d4', '#1a1a1a'], fonts: ['Inter'] })
  })

  it('applies a color to the selection or to the artboard, and the font to text layers', () => {
    const selected = applyBrandColor(fixture(), ['r', 'h'], '#5645d4')
    expect(selected.nodes.r.fill).toBe('#5645d4')
    expect(selected.nodes.h.fill).toBe('#5645d4')
    expect(selected.pages[0].background).toBe('#ffffff')
    const artboard = applyBrandColor(fixture(), [], '#101010')
    expect(artboard.pages[0].background).toBe('#101010')
    const fontOnSelection = applyBrandFont(fixture(), ['h', 'r'], 'Inter')
    expect(fontOnSelection.nodes.h.fontFamily).toBe('Inter')
    expect(fontOnSelection.nodes.b.fontFamily).toBe('Arial')
    const fontEverywhere = applyBrandFont(fixture(), [], 'Lora')
    expect([fontEverywhere.nodes.h.fontFamily, fontEverywhere.nodes.b.fontFamily]).toEqual(['Lora', 'Lora'])
    const empty = createDesign('Empty')
    expect(applyBrandFont(empty, [], 'Lora')).toBe(empty)
  })
})
