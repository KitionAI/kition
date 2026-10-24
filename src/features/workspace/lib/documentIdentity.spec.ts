import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = {
  renameDocument: vi.fn(async (..._args: unknown[]) => {}),
  renameDocumentFolder: vi.fn(async (..._args: unknown[]) => {}),
  forgetDocument: vi.fn(async (..._args: unknown[]) => {}),
  forgetDocumentFolder: vi.fn(async (..._args: unknown[]) => {}),
  duplicateDocumentIdentity: vi.fn(async (..._args: unknown[]) => {}),
}

vi.mock('@/lib/docstore/documentIndex', () => store)

import {
  syncDocumentFileDeleted,
  syncDocumentFileDuplicated,
  syncDocumentFileMoved,
  syncDocumentFolderDeleted,
  syncDocumentFolderMoved,
} from './documentIdentity'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('documentIdentity', () => {
  it('forwards each tree operation to the store with the workspace root', async () => {
    await syncDocumentFileMoved('/ws', 'a.md', 'b.md')
    await syncDocumentFolderMoved('/ws', 'A', 'B')
    await syncDocumentFileDeleted('/ws', 'a.md')
    await syncDocumentFolderDeleted('/ws', 'A')
    await syncDocumentFileDuplicated('/ws', 'a.md', 'a copy.md')
    const options = { expectedRoot: '/ws' }
    expect(store.renameDocument).toHaveBeenCalledWith('a.md', 'b.md', options)
    expect(store.renameDocumentFolder).toHaveBeenCalledWith('A', 'B', options)
    expect(store.forgetDocument).toHaveBeenCalledWith('a.md', options)
    expect(store.forgetDocumentFolder).toHaveBeenCalledWith('A', options)
    expect(store.duplicateDocumentIdentity).toHaveBeenCalledWith('a.md', 'a copy.md', options)
  })

  it('skips moves that change nothing and omits an unknown root', async () => {
    await syncDocumentFileMoved('/ws', 'a.md', 'a.md')
    await syncDocumentFolderMoved('/ws', '', 'B')
    expect(store.renameDocument).not.toHaveBeenCalled()
    expect(store.renameDocumentFolder).not.toHaveBeenCalled()
    await syncDocumentFileDeleted('', 'a.md')
    expect(store.forgetDocument).toHaveBeenCalledWith('a.md', {})
  })

  it('logs a store failure instead of throwing', async () => {
    store.renameDocument.mockRejectedValueOnce(new Error('store offline'))
    await expect(syncDocumentFileMoved('/ws', 'a.md', 'b.md')).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('document store'), expect.objectContaining({ message: 'store offline' }))
  })
})
