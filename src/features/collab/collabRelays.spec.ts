import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KitConnection } from '@/features/kits/public'
import { registerKitConnection } from '@/features/kits/kition/kitConnections'
import { startCollab, type CollabDependencies } from './collabRelays'
import { writeRoom } from './rooms'

function kitConnection(capabilities: string[]) {
  const replica = {
    info: vi.fn(async () => 'doc-1'),
    version: vi.fn(async () => new ArrayBuffer(0)),
    exportChanges: vi.fn(async () => ({ changes: new ArrayBuffer(0), blobs: new ArrayBuffer(0) })),
    importChanges: vi.fn(async () => ({ damage: null })),
    onChanged: vi.fn(() => () => undefined),
  }
  return { connection: { capabilities, replica } as unknown as KitConnection, replica }
}

function dependencies(configured: boolean) {
  const client = vi.fn<CollabDependencies['client']>(async () => null)
  return { client, deps: { configured: async () => configured, client, versions: vi.fn() } satisfies CollabDependencies }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  localStorage.clear()
})

describe('startCollab', () => {
  it('never connects or reads the replica without a sync server and a Kition Pro session', async () => {
    writeRoom({ docId: 'doc-1', shareLink: 'https://example.test/s/1', name: 'Poster.psd', kit: 'kit.photo', role: 'owner' })
    const { client, deps } = dependencies(false)
    const { connection, replica } = kitConnection(['ai', 'replica'])
    cleanups.push(startCollab(deps), registerKitConnection({ path: 'Poster.psd', kitId: 'kit.photo', connection }))
    await flush()
    expect(client).not.toHaveBeenCalled()
    expect(replica.info).not.toHaveBeenCalled()
  })

  it('never connects for a document that is not shared, or a kit without a replica', async () => {
    const { client, deps } = dependencies(true)
    const shared = kitConnection(['ai'])
    const unshared = kitConnection(['ai', 'replica'])
    cleanups.push(
      startCollab(deps),
      registerKitConnection({ path: 'Old.psd', kitId: 'kit.photo', connection: shared.connection }),
      registerKitConnection({ path: 'Poster.psd', kitId: 'kit.photo', connection: unshared.connection }),
    )
    await flush()
    // Poster.psd has no room, and Old.psd's kit keeps no replica.
    expect(shared.replica.info).not.toHaveBeenCalled()
    expect(client).not.toHaveBeenCalled()
  })

  it('connects once a document it follows is shared', async () => {
    const { client, deps } = dependencies(true)
    const { connection } = kitConnection(['ai', 'replica'])
    cleanups.push(startCollab(deps), registerKitConnection({ path: 'Poster.psd', kitId: 'kit.photo', connection }))
    await flush()
    expect(client).not.toHaveBeenCalled()
    writeRoom({ docId: 'doc-1', shareLink: 'https://example.test/s/1', name: 'Poster.psd', kit: 'kit.photo', role: 'owner' })
    await flush()
    expect(client).toHaveBeenCalledTimes(1)
  })
})
