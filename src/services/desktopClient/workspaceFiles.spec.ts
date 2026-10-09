import { describe, expect, it, vi } from 'vitest'
import { openWorkspaceFile } from './workspaceFiles'

const openFile = vi.hoisted(() => vi.fn())
vi.mock('./bridge', () => ({ getDesktopBridge: () => ({ OpenWorkspaceFile: openFile }) }))

describe('system application launch results', () => {
  it('converts the desktop error string into a rejection', async () => {
    openFile.mockResolvedValueOnce('No application is associated with this file')
    await expect(openWorkspaceFile('draft.md')).rejects.toThrow('No application')
  })

  it('accepts the empty success result from the desktop shell', async () => {
    openFile.mockResolvedValueOnce('')
    await expect(openWorkspaceFile('draft.md')).resolves.toBe('')
    expect(openFile).toHaveBeenLastCalledWith({ path: 'draft.md' })
  })
})
