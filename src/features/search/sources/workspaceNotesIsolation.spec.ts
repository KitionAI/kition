import { beforeEach, expect, it, vi } from 'vitest'

const list = vi.hoisted(() => vi.fn())
vi.mock('@/services/desktop', () => ({ listWorkspaceDocuments: list }))

function listing(root: string, name: string) {
  return { root_path: root, items: [{ type: 'file' as const, path: name, name }] }
}

beforeEach(() => {
  vi.resetModules()
  list.mockReset()
})

it('lists a newly selected workspace even inside the previous listing TTL', async () => {
  list.mockResolvedValueOnce(listing('/workspace-a', 'Private.md'))
    .mockResolvedValueOnce(listing('/workspace-b', 'Public.md'))
  const { loadWorkspaceNotes } = await import('./workspaceNotes')
  expect((await loadWorkspaceNotes('/workspace-a')).map(file => file.path)).toEqual(['Private.md'])
  expect((await loadWorkspaceNotes('/workspace-b')).map(file => file.path)).toEqual(['Public.md'])
  expect(list).toHaveBeenCalledTimes(2)
})

it('an old workspace response cannot replace the new workspace cache', async () => {
  let resolveOld!: (value: ReturnType<typeof listing>) => void
  list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(listing('/workspace-b', 'Public.md'))
  const { loadWorkspaceNotes } = await import('./workspaceNotes')
  const old = loadWorkspaceNotes('/workspace-a')
  const current = await loadWorkspaceNotes('/workspace-b')
  resolveOld(listing('/workspace-a', 'Private.md'))
  await old
  expect(await loadWorkspaceNotes('/workspace-b')).toBe(current)
  expect(current.map(file => file.path)).toEqual(['Public.md'])
  expect(list).toHaveBeenCalledTimes(2)
})

it('reload invalidates an in-flight listing without allowing it to restore stale files', async () => {
  let resolveOld!: (value: ReturnType<typeof listing>) => void
  list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(listing('/workspace-a', 'New.md'))
  const { loadWorkspaceNotes, invalidateWorkspaceNotes } = await import('./workspaceNotes')
  const old = loadWorkspaceNotes('/workspace-a')
  invalidateWorkspaceNotes()
  const current = await loadWorkspaceNotes('/workspace-a')
  resolveOld(listing('/workspace-a', 'Old.md'))
  await old
  expect(await loadWorkspaceNotes('/workspace-a')).toBe(current)
  expect(current.map(file => file.path)).toEqual(['New.md'])
  expect(list).toHaveBeenCalledTimes(2)
})

it('does not index a listing returned from a different workspace', async () => {
  list.mockResolvedValueOnce(listing('/workspace-b', 'Public.md'))
    .mockResolvedValueOnce(listing('/workspace-a', 'Private.md'))
  const { loadWorkspaceNotes } = await import('./workspaceNotes')
  await expect(loadWorkspaceNotes('/workspace-a')).rejects.toThrow('Workspace changed')
  expect((await loadWorkspaceNotes('/workspace-a')).map(file => file.path)).toEqual(['Private.md'])
  expect(list).toHaveBeenCalledTimes(2)
})
