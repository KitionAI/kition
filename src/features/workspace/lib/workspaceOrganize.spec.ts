/**
 * Every workspace file can be renamed and moved from the tree, not only notes and boards: a
 * rename keeps the file's own extension, and a file's same-named folder of child pages follows it.
 */
import { describe, expect, it } from 'vitest'

import { remapWorkspaceBranchPath, renameWorkspaceDocumentPath } from './workspace'

describe('renameWorkspaceDocumentPath', () => {
  it.each([
    ['notes/a.md', 'b', 'notes/b.md'],
    ['Plan.kboard', 'Roadmap', 'Roadmap.kboard'],
    ['finance/Budget.xlsx', 'Plan 2027', 'finance/Plan 2027.xlsx'],
    ['Deck.kslide', 'Pitch', 'Pitch.kslide'],
    ['Page.html', 'Home', 'Home.html'],
    ['scan.bin', 'archive', 'archive.bin'],
  ])('renames %s to "%s" as %s', (path, title, renamed) => {
    expect(renameWorkspaceDocumentPath(path, title)).toBe(renamed)
  })

  it('does not add the extension again when the new name already has it', () => {
    expect(renameWorkspaceDocumentPath('Budget.xlsx', 'Plan.XLSX')).toBe('Plan.XLSX')
  })
})

describe('remapWorkspaceBranchPath', () => {
  it("moves a kit file's child pages with it", () => {
    expect(remapWorkspaceBranchPath('Deck/notes.md', 'Deck.kslide', 'talks/Pitch.kslide')).toBe('talks/Pitch/notes.md')
    expect(remapWorkspaceBranchPath('Deck.kslide', 'Deck.kslide', 'talks/Pitch.kslide')).toBe('talks/Pitch.kslide')
    expect(remapWorkspaceBranchPath('Other/a.md', 'Deck.kslide', 'Pitch.kslide')).toBe('Other/a.md')
  })
})
