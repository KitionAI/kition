import { describe, expect, it } from 'vitest'

import { kitCreateExtensions } from '@/features/workspace/components/kits/kitFormats'
import { getWorkspaceItemTitle } from './workspace'

describe('getWorkspaceItemTitle', () => {
  it.each([
    ['Launch.md', 'Launch'],
    ['Notes.markdown', 'Notes'],
    ['Leads.ktable', 'Leads'],
    ['Plan.kboard', 'Plan'],
    ['Poster.kidesign', 'Poster'],
    ['Report.docx', 'Report'],
    ['Budget.xlsx', 'Budget'],
    ['Deck.pptx', 'Deck'],
    ['Handbook.pdf', 'Handbook'],
  ])('drops the extension from %s already in the base list', (name, title) => {
    expect(getWorkspaceItemTitle(name)).toBe(title)
  })

  it.each([
    ['Photo.psd', 'Photo'],
    ['Logo.kvector', 'Logo'],
    ['Flyer.kdesign', 'Flyer'],
    ['Movie.kfilm', 'Movie'],
    ['Clip.keffect', 'Clip'],
    ['Part.dxf', 'Part'],
    ['Deck.kslide', 'Deck'],
  ])('drops a kit-owned extension from %s, same as the formats kitEditors.ts already knows', (name, title) => {
    expect(getWorkspaceItemTitle(name)).toBe(title)
  })

  it('is case-insensitive', () => {
    expect(getWorkspaceItemTitle('Photo.PSD')).toBe('Photo')
    expect(getWorkspaceItemTitle('Movie.KFILM')).toBe('Movie')
  })

  it('drops every extension the kit registry creates (kitFormats.ts), so a renamed kit extension never regresses this', () => {
    for (const extension of kitCreateExtensions()) {
      expect(getWorkspaceItemTitle(`Untitled.${extension}`)).toBe('Untitled')
    }
  })

  it('leaves an unrecognized extension alone', () => {
    expect(getWorkspaceItemTitle('archive.zip')).toBe('archive.zip')
  })
})
