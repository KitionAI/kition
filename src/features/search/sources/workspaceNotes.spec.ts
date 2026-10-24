import { beforeEach, describe, expect, it, vi } from 'vitest'

const listed = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/services/desktop', () => ({
  listWorkspaceDocuments: vi.fn(async () => {
    listed.calls += 1
    return {
      root_path: '/ws',
      items: [
        { type: 'file', path: 'Plan.md', name: 'Plan.md' },
        { type: 'file', path: 'data.ktable', name: 'data.ktable' },
        { type: 'folder', path: 'notes', name: 'notes', children: [{ type: 'file', path: 'notes/Today.MD', name: 'Today.MD' }] },
      ],
    }
  }),
}))

beforeEach(() => {
  listed.calls = 0
})

describe('loadWorkspaceNotes', () => {
  it('lists the workspace’s notes in every folder, once for calls close together', async () => {
    const { loadWorkspaceNotes } = await import('./workspaceNotes')
    const [first, second] = await Promise.all([loadWorkspaceNotes(), loadWorkspaceNotes()])
    expect(first.map((file) => file.path)).toEqual(['Plan.md', 'notes/Today.MD'])
    expect(second).toBe(first)
    expect(await loadWorkspaceNotes()).toBe(first)
    expect(listed.calls).toBe(1)
  })
})
