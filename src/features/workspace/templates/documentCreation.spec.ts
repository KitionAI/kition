import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentWorkspaceEntry } from './documentCreation'

const createWorkspaceDocument = vi.fn()
const writeWorkspaceDocument = vi.fn()

vi.mock('@/services/desktop', () => ({
  createWorkspaceDocument: (...args: unknown[]) => createWorkspaceDocument(...args),
  writeWorkspaceDocument: (...args: unknown[]) => writeWorkspaceDocument(...args),
}))

describe('createDocumentWorkspaceEntry', () => {
  beforeEach(() => {
    createWorkspaceDocument.mockReset()
    createWorkspaceDocument.mockResolvedValue({ path: 'Untitled.md', content: '' })
    writeWorkspaceDocument.mockReset()
    writeWorkspaceDocument.mockResolvedValue({ path: 'Project brief.md', content: '# Project brief' })
  })

  it('creates at the workspace root unless given a folder', async () => {
    await createDocumentWorkspaceEntry({})
    expect(createWorkspaceDocument).toHaveBeenCalledWith(expect.objectContaining({ folder: '', title: 'Untitled note' }))
    await createDocumentWorkspaceEntry({ folder: 'Agent' })
    expect(createWorkspaceDocument).toHaveBeenLastCalledWith(expect.objectContaining({ folder: 'Agent' }))
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })

  it('creates a named document and writes template content', async () => {
    const result = await createDocumentWorkspaceEntry({
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
    expect(result).toEqual(expect.objectContaining({ content: '# Project brief' }))
  })
})
