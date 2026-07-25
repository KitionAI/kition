import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentWorkspaceEntry, getDocumentParentPath } from './documentCreation'

const createWorkspaceDocument = vi.fn()

vi.mock('@/services/desktop', () => ({
  createWorkspaceDocument: (...args: unknown[]) => createWorkspaceDocument(...args),
}))

describe('getDocumentParentPath', () => {
  it('returns parent folder for nested paths', () => {
    expect(getDocumentParentPath('Knowledge base/07_Rethinking.md')).toBe('Knowledge base')
  })

  it('returns empty string for root-level paths', () => {
    expect(getDocumentParentPath('inbox.md')).toBe('')
  })
})

describe('createDocumentWorkspaceEntry', () => {
  beforeEach(() => {
    createWorkspaceDocument.mockReset()
    createWorkspaceDocument.mockResolvedValue({ path: 'Untitled.md', content: '' })
  })

  // Regression: creating from the root "+" passes folderOverride '' (root). It must
  // land at root even when a subfolder document is open — not inherit that doc's parent.
  it('creates at root when folderOverride is empty, ignoring the active document folder', async () => {
    await createDocumentWorkspaceEntry({
      activeDocumentPath: 'Knowledge base/07_Rethinking.md',
      folderOverride: '',
      platform: 'page',
    })
    expect(createWorkspaceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '' }),
    )
  })

  it('honors an explicit folder override', async () => {
    await createDocumentWorkspaceEntry({
      activeDocumentPath: 'Knowledge base/07_Rethinking.md',
      folderOverride: 'Agent',
      platform: 'page',
    })
    expect(createWorkspaceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'Agent' }),
    )
  })
})
