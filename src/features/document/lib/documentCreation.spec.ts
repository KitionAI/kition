import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentWorkspaceEntry, getDocumentParentPath } from './documentCreation'

const createWorkspaceDocument = vi.fn()
const writeWorkspaceDocument = vi.fn()

vi.mock('@/services/desktop', () => ({
  createWorkspaceDocument: (...args: unknown[]) => createWorkspaceDocument(...args),
  writeWorkspaceDocument: (...args: unknown[]) => writeWorkspaceDocument(...args),
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
    writeWorkspaceDocument.mockReset()
    writeWorkspaceDocument.mockResolvedValue({ path: 'Project brief.md', content: '# Project brief' })
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

  it('creates a named document and writes template content', async () => {
    const result = await createDocumentWorkspaceEntry({
      folderOverride: '',
      platform: 'page',
      preset: {
        title: 'Project brief',
        content: '# Project brief',
        templateId: 'project-brief',
      },
    })

    expect(createWorkspaceDocument).toHaveBeenCalledWith(expect.objectContaining({
      folder: '',
      title: 'Project brief',
    }))
    expect(writeWorkspaceDocument).toHaveBeenCalledWith('Untitled.md', '# Project brief')
    expect(result.document).toEqual(expect.objectContaining({ content: '# Project brief' }))
  })
})
