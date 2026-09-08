import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesign, createDesignNode } from './designTypes'
import { serializeDesign } from './designSerialization'
import { DesignSession } from './designSession'
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
} from '@/services/desktop'
vi.mock('@/services/desktop', () => ({
  readWorkspaceDocument: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
}))
beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
describe('Design save sequencing and recovery', () => {
  it('serializes pending writes and captures the exact root, path, and source bytes', async () => {
    let release!: () => void
    vi.mocked(writeWorkspaceDocument)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ path: 'Poster.kidesign', name: 'Poster', content: '' })
          }),
      )
      .mockResolvedValue({
        path: 'Poster.kidesign',
        name: 'Poster',
        content: '',
      })
    const content = serializeDesign(createDesign()),
      session = new DesignSession('/workspace-one', 'Poster.kidesign', content),
      disconnect = session.connect()
    session.store.execute({
      type: 'insert',
      nodes: [createDesignNode('text', { id: 'text', text: 'First' })],
    })
    const saving = session.flush()
    session.store.execute({
      type: 'patch',
      ids: ['text'],
      patch: { text: 'Second' },
    })
    expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
    release()
    await saving
    expect(writeWorkspaceDocument).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(writeWorkspaceDocument).mock.calls
    expect(first[2]).toEqual({
      expected_root: '/workspace-one',
      expected_content: content,
    })
    expect(second[2]).toEqual({
      expected_root: '/workspace-one',
      expected_content: first[1],
    })
    expect(JSON.parse(second[1]).nodes.text.text).toBe('Second')
    expect(session.getStatus()).toBe('saved')
    disconnect()
  })
  it('preserves edits and source bytes on a compare-and-write conflict', async () => {
    const content = serializeDesign(createDesign()),
      session = new DesignSession('/workspace-one', 'Poster.kidesign', content),
      disconnect = session.connect()
    session.store.execute({
      type: 'insert',
      nodes: [createDesignNode('text', { id: 'text', text: 'Keep me' })],
    })
    vi.mocked(writeWorkspaceDocument).mockRejectedValue(
      new Error('DESIGN_SAVE_CONFLICT'),
    )
    await expect(session.flush()).rejects.toThrow('DESIGN_SAVE_CONFLICT')
    expect(session.getStatus()).toBe('conflict')
    await expect(session.flush()).rejects.toThrow()
    expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
    const recovered = new DesignSession(
      '/workspace-one',
      'Poster.kidesign',
      content,
    )
    expect(recovered.getStatus()).toBe('recovered')
    expect(recovered.store.getSnapshot().document.nodes.text.text).toBe(
      'Keep me',
    )
    const otherWorkspace = new DesignSession(
      '/workspace-two',
      'Poster.kidesign',
      content,
    )
    expect(otherWorkspace.store.getSnapshot().document.nodes).toEqual({})
    disconnect()
  })
  it('never loads corrupt/newer files as an empty editable design', () => {
    expect(() => new DesignSession('/workspace', 'Bad.kidesign', '{')).toThrow()
    expect(
      () =>
        new DesignSession(
          '/workspace',
          'Future.kidesign',
          JSON.stringify({ ...createDesign(), version: 99 }),
        ),
    ).toThrow()
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })
  it('detects an external edit without overwriting either version', async () => {
    const content = serializeDesign(createDesign()),
      session = new DesignSession('/workspace', 'Poster.kidesign', content)
    vi.mocked(readWorkspaceDocument).mockResolvedValue({
      path: 'Poster.kidesign',
      name: 'Poster',
      content: content.replace('Untitled design', 'External'),
    })
    await session.checkExternal()
    expect(session.getStatus()).toBe('conflict')
    expect(session.store.getSnapshot().document.title).toBe('Untitled design')
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()
  })
})

it('does not rewrite an unchanged valid source just to normalize its JSON formatting', async () => {
  const content = JSON.stringify(createDesign())
  const session = new DesignSession('/workspace', 'Untouched.kidesign', content)
  const disconnect = session.connect()
  await session.flush()
  disconnect()
  expect(writeWorkspaceDocument).not.toHaveBeenCalled()
})

it('does not retry abandoned edits when reloading a saved source after a save error', async () => {
  const session = new DesignSession(
    '/workspace',
    'Poster.kidesign',
    serializeDesign(createDesign()),
  )
  const disconnect = session.connect()
  session.store.execute({ type: 'insert', nodes: [createDesignNode('text')] })
  vi.mocked(writeWorkspaceDocument).mockRejectedValue(
    new Error('Disk unavailable'),
  )
  await expect(session.flush()).rejects.toThrow('Disk unavailable')
  session.discardRecovery()
  disconnect()
  await session.flush()
  expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
})
