import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocumentExternalChange } from '@/services/desktop'
import { followKitFileChanges } from './kitFileChanges'

/** A watcher the test drives: `emit` plays the desktop shell's change event. */
function watcher() {
  const handlers = new Set<(change: WorkspaceDocumentExternalChange) => void>()
  return {
    subscribe: (handler: (change: WorkspaceDocumentExternalChange) => void) => {
      handlers.add(handler)
      return () => void handlers.delete(handler)
    },
    emit: (change: WorkspaceDocumentExternalChange) => {
      for (const handler of handlers) handler(change)
    },
  }
}

describe('followKitFileChanges', () => {
  it("tells the kit of its own file's changes with the new stamp, and nothing else", async () => {
    const files = watcher()
    const connection = { fileChanged: vi.fn() }
    const stop = followKitFileChanges('notes/Plan.md', connection, async () => 'v2', files.subscribe)
    files.emit({ path: 'notes/Other.md', eventType: 'change' })
    files.emit({ path: 'notes/Plan.md', eventType: 'unlink' })
    files.emit({ path: 'notes/Plan.md', eventType: 'change' })
    files.emit({ path: 'notes/Plan.md', eventType: 'add' })
    await vi.waitFor(() => expect(connection.fileChanged).toHaveBeenCalledTimes(2))
    expect(connection.fileChanged).toHaveBeenCalledWith('v2')
    stop()
    files.emit({ path: 'notes/Plan.md', eventType: 'change' })
    await Promise.resolve()
    expect(connection.fileChanged).toHaveBeenCalledTimes(2)
  })

  it('sends nothing without a stamp, after the editor closed, or when the stamp fails', async () => {
    const files = watcher()
    const connection = { fileChanged: vi.fn() }
    let answer: (stamp: string | null) => void = () => undefined
    const stop = followKitFileChanges('a.md', connection, () => new Promise((resolve) => (answer = resolve)), files.subscribe)
    files.emit({ path: 'a.md', eventType: 'change' })
    stop()
    answer('v3')
    const none = followKitFileChanges('a.md', connection, async () => null, files.subscribe)
    files.emit({ path: 'a.md', eventType: 'change' })
    const failing = followKitFileChanges('a.md', connection, async () => Promise.reject(new Error('gone')), files.subscribe)
    files.emit({ path: 'a.md', eventType: 'change' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(connection.fileChanged).not.toHaveBeenCalled()
    none()
    failing()
  })
})
