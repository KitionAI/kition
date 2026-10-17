import { afterEach, describe, expect, it, vi } from 'vitest'
import * as replicaApi from '@/api/dataDocumentsReplica'
import type { KitConnection } from '@/features/kits/public'
import { registerKitConnection } from '@/features/kits/kition/kitConnections'
import { isDocumentReadOnly } from '@/services/documentAccess'
import { startCollab, type CollabDependencies } from './collabRelays'
import { readRoom, toHex, writeRoom } from './rooms'
import * as tableReplica from './tableReplica'

vi.mock('./tableReplica', () => ({ createTableRelayReplica: vi.fn() }))
vi.mock('@/api/dataDocumentsReplica', () => ({ getTableReplicaVersion: vi.fn(), createTableFromReplica: vi.fn() }))

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

describe('startCollab for documents Kition edits itself', () => {
  function fakeClient() {
    const joins: Array<{ docId: string; since: number | null | undefined }> = []
    const client = {
      state: 'online' as const,
      principal: { id: 'u:me', name: 'Me' },
      join: vi.fn(async (docId: string, since?: number | null) => {
        joins.push({ docId, since })
        return { changes: [], seq: 5, more: false, presence: [], role: 'editor' as const }
      }),
      leave: vi.fn(),
      push: vi.fn(async () => ({ seq: 6 })),
      onChanges: vi.fn(() => () => undefined),
      onState: vi.fn(() => () => undefined),
      setPresence: vi.fn(),
      onPresence: vi.fn(() => () => undefined),
      blobs: { has: vi.fn(async (hashes: string[]) => ({ missing: hashes })), put: vi.fn(), get: vi.fn() },
    }
    return { client, joins }
  }

  async function openBoard(path: string) {
    const { BoardStore } = await import('@/features/whiteboard/lib/boardStore')
    const { registerOpenBoard } = await import('@/features/whiteboard/lib/openBoards')
    const store = new BoardStore()
    const withdraw = registerOpenBoard({ path, replica: () => store.getReplica(), importChanges: (changes) => store.importChanges(changes), subscribe: store.subscribe, save: async () => undefined })
    return { store, withdraw }
  }

  it('relays a shared board, joining from the seq an earlier session saw while the replica still holds it', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('./replicaVersions')
    const { client, joins } = fakeClient()
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const { store, withdraw } = await openBoard('Plan.kiboard')
    const docId = store.getReplica().docId
    const version = toHex(store.getReplica().version().encode())
    writeRoom({ docId, shareLink: 'https://example.test/s/2', name: 'Plan.kiboard', kit: 'kit.board', role: 'editor', seen: { seq: 3, version } })
    cleanups.push(startCollab(deps), withdraw)
    await vi.waitFor(() => expect(joins).toEqual([{ docId, since: 3 }]))
    // The join's seq is kept for next time.
    await vi.waitFor(() => expect(readRoom(docId)?.seen?.seq).toBe(5))
  })

  it('joins from the snapshot when the replica no longer holds what was seen', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('./replicaVersions')
    const { client, joins } = fakeClient()
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const { store, withdraw } = await openBoard('Plan.kiboard')
    const docId = store.getReplica().docId
    // A version with changes of an author this replica never had.
    const elsewhere = await openBoard('Elsewhere.kiboard')
    cleanups.push(elsewhere.withdraw)
    const ahead = elsewhere.store.getReplica().version().encode()
    writeRoom({ docId, shareLink: 'https://example.test/s/2', name: 'Plan.kiboard', kit: 'kit.board', role: 'editor', seen: { seq: 3, version: toHex(ahead) } })
    cleanups.push(startCollab(deps), withdraw)
    await vi.waitFor(() => expect(joins).toEqual([{ docId, since: null }]))
  })

  it('makes the documents of viewer rooms read-only, and follows a role the room answers', async () => {
    writeRoom({ docId: 'doc-v', shareLink: 'https://example.test/s/v', name: 'Notes.md', kit: 'kit.document', role: 'viewer', path: 'Shared/Notes.md' })
    cleanups.push(startCollab({ configured: async () => false, client: async () => null, versions: vi.fn() }))
    expect(isDocumentReadOnly('Shared/Notes.md')).toBe(true)
    writeRoom({ docId: 'doc-v', shareLink: 'https://example.test/s/v', name: 'Notes.md', kit: 'kit.document', role: 'editor', path: 'Shared/Notes.md' })
    expect(isDocumentReadOnly('Shared/Notes.md')).toBe(false)
  })

  it('never touches a table replica without a sync server and a Kition Pro session', async () => {
    const { registerOpenTable } = await import('@/features/table/lib/openTables')
    const { client, deps } = dependencies(false)
    cleanups.push(startCollab(deps), registerOpenTable({ path: 'Tasks.kitable' }))
    await flush()
    expect(client).not.toHaveBeenCalled()
    expect(tableReplica.createTableRelayReplica).not.toHaveBeenCalled()
    expect(replicaApi.getTableReplicaVersion).not.toHaveBeenCalled()
  })
})
