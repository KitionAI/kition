import { afterEach, describe, expect, it, vi } from 'vitest'
import * as replicaApi from '@/api/dataDocumentsReplica'
import type { KitConnection } from '@/features/kits/public'
import { registerKitConnection } from '@/features/kits/kition/kitConnections'
import { isDocumentReadOnly } from '@/services/documentAccess'
import { documentCommentAccess } from '@/services/documentComments'
import { presencePeers, setLocalPresence } from '@/services/documentPresence'
import { documentSchemaNotice } from '@/services/documentSchema'
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
    const access: Array<(role: 'owner' | 'editor' | 'commenter' | 'viewer' | null) => void> = []
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
      onAccess: vi.fn((_docId: string, listener: (role: 'owner' | 'editor' | 'commenter' | 'viewer' | null) => void) => {
        access.push(listener)
        return () => undefined
      }),
      blobs: { has: vi.fn(async (hashes: string[]) => ({ missing: hashes })), put: vi.fn(), get: vi.fn() },
    }
    return { client, joins, access }
  }

  async function openBoard(path: string) {
    const { BoardStore } = await import('@/features/whiteboard/lib/boardStore')
    const { registerOpenBoard } = await import('@/features/whiteboard/lib/openBoards')
    const store = new BoardStore()
    const withdraw = registerOpenBoard({ path, replica: () => store.getReplica(), importChanges: (changes) => store.importChanges(changes), subscribe: store.subscribe, save: async () => undefined })
    return { store, withdraw }
  }

  it('relays a shared board, joining from the seq an earlier session saw while the replica still holds it', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
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
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
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

  it('keeps a commenter’s document read-only, yet lets them comment', async () => {
    writeRoom({ docId: 'doc-c', shareLink: 'https://example.test/s/c', name: 'Notes.md', kit: 'kit.document', role: 'commenter', path: 'Shared/Notes.md' })
    cleanups.push(startCollab({ configured: async () => false, client: async () => null, versions: vi.fn() }))
    expect(isDocumentReadOnly('Shared/Notes.md')).toBe(true)
  })

  it('follows the owner changing this person’s role, and keeps a local copy once removed', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
    const { client, joins, access } = fakeClient()
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const { store, withdraw } = await openBoard('Shared/Plan.kiboard')
    const docId = store.getReplica().docId
    writeRoom({ docId, shareLink: 'https://example.test/s/3', name: 'Plan.kiboard', kit: 'kit.board', role: 'editor', path: 'Shared/Plan.kiboard' })
    cleanups.push(startCollab(deps), withdraw)
    await vi.waitFor(() => expect(joins).toHaveLength(1))
    // Joined as an editor: comments are written as the room's principal, and others' are not history.
    await vi.waitFor(() => expect(documentCommentAccess('Shared/Plan.kiboard', false)).toMatchObject({ me: 'u:me', canComment: true, othersReadOnly: false }))
    await vi.waitFor(() => expect(access).toHaveLength(1))

    access[0]('viewer')
    expect(readRoom(docId)?.role).toBe('viewer')
    expect(isDocumentReadOnly('Shared/Plan.kiboard')).toBe(true)
    expect(documentCommentAccess('Shared/Plan.kiboard', true).canComment).toBe(false)

    access[0](null)
    expect(readRoom(docId)).toBeNull()
    expect(isDocumentReadOnly('Shared/Plan.kiboard')).toBe(false)
    // No longer co-edited: others' threads are history.
    expect(documentCommentAccess('Shared/Plan.kiboard', false)).toMatchObject({ canComment: true, othersReadOnly: true })
  })

  it('shows the agent in presence while it edits the document, and then no longer', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
    const { noteAgentEdit } = await import('@/services/agentPresence')
    const { client, joins } = fakeClient()
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const { store, withdraw } = await openBoard('Shared/Agent.kiboard')
    const docId = store.getReplica().docId
    writeRoom({ docId, shareLink: 'https://example.test/s/4', name: 'Agent.kiboard', kit: 'kit.board', role: 'editor', path: 'Shared/Agent.kiboard' })
    cleanups.push(startCollab(deps), withdraw)
    await vi.waitFor(() => expect(joins).toHaveLength(1))
    await vi.waitFor(() => expect(client.setPresence).toHaveBeenCalledTimes(1))
    const [, joined] = client.setPresence.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(joined.agent).toBeUndefined()

    noteAgentEdit('Shared/Agent.kiboard', 20)
    expect(client.setPresence).toHaveBeenLastCalledWith(docId, { ...joined, agent: { name: 'Agent', origin: 'agent' } })
    // Another edit while it is there changes nothing; once it is quiet, it leaves.
    noteAgentEdit('Shared/Agent.kiboard', 20)
    expect(client.setPresence).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.setPresence).toHaveBeenLastCalledWith(docId, joined))
  })

  it('shares what the person selected in presence, and tells the editor what the others share', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
    const { client, joins } = fakeClient()
    const heard: Array<(peers: unknown[]) => void> = []
    client.onPresence = vi.fn((_docId: string, listener: (peers: unknown[]) => void) => {
      heard.push(listener)
      return () => undefined
    }) as never
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const path = 'Shared/Selection.kiboard'
    const { store, withdraw } = await openBoard(path)
    const docId = store.getReplica().docId
    writeRoom({ docId, shareLink: 'https://example.test/s/5', name: 'Selection.kiboard', kit: 'kit.board', role: 'viewer', path })
    cleanups.push(startCollab(deps), withdraw)
    await vi.waitFor(() => expect(joins).toHaveLength(1))
    await vi.waitFor(() => expect(client.setPresence).toHaveBeenCalledTimes(1))
    expect(client.setPresence).toHaveBeenLastCalledWith(docId, { kit: 'kit.board' })

    // A viewer shares what it selected too: where it looks, never an edit.
    setLocalPresence(path, { selection: ['shape-1'], caret: { object: 'note-1', field: 'text', offset: 2 } })
    expect(client.setPresence).toHaveBeenLastCalledWith(docId, { kit: 'kit.board', selection: ['shape-1'], caret: { object: 'note-1', field: 'text', offset: 2 } })

    heard[0]([
      { principalId: 'u:me', name: 'Me', color: '#111111', state: { kit: 'kit.board', selection: ['shape-1'] } },
      { principalId: 'u:alice', name: 'Alice', color: '#e5484d', state: { kit: 'kit.board', selection: ['shape-2', 7], caret: { object: 'x', field: 'text', offset: -1 } } },
      { principalId: 'u:bob', name: 'Bob', color: '#3e63dd', state: null },
    ])
    expect(presencePeers(path)).toEqual([
      { principal: 'u:alice', name: 'Alice', color: '#e5484d', selection: ['shape-2'] },
      { principal: 'u:bob', name: 'Bob', color: '#3e63dd', selection: [] },
    ])
    setLocalPresence(path, null)
  })

  it('keeps a document a newer kit migrated read-only, and never keeps the room position past the refused change', async () => {
    const { LORO_REPLICA_VERSIONS } = await import('@/lib/sync/replicaVersions')
    const { client, joins } = fakeClient()
    client.join = vi.fn(async (docId: string, since?: number | null) => {
      joins.push({ docId, since })
      return { changes: [new Uint8Array([1, 2, 3])], seq: 5, more: false, presence: [], role: 'editor' as const }
    }) as never
    const pulled: Array<(notice: { changes: Uint8Array; seq: number }) => void> = []
    client.onChanges = vi.fn((_docId: string, listener: (notice: { changes: Uint8Array; seq: number }) => void) => {
      pulled.push(listener)
      return () => undefined
    }) as never
    const deps: CollabDependencies = { configured: async () => true, client: async () => client as never, versions: async () => LORO_REPLICA_VERSIONS }
    const { connection, replica } = kitConnection(['ai', 'replica'])
    replica.importChanges.mockRejectedValueOnce(new Error('presentation replica: the document needs schema version 4; this kit reads schema versions up to 3'))
    writeRoom({ docId: 'doc-1', shareLink: 'https://example.test/s/6', name: 'Deck.kitionslide', kit: 'kit.slide', role: 'editor', path: 'Shared/Deck.kitionslide' })
    cleanups.push(startCollab(deps), registerKitConnection({ path: 'Shared/Deck.kitionslide', kitId: 'kit.slide', connection }))
    await vi.waitFor(() => expect(replica.importChanges).toHaveBeenCalled())
    await vi.waitFor(() => expect(isDocumentReadOnly('Shared/Deck.kitionslide')).toBe(true))
    expect(documentSchemaNotice('Shared/Deck.kitionslide')).toEqual({ kit: 'kit.slide', needs: 4, reads: 3, blocked: true })
    // A later change the replica takes (it waits on the refused one) does not move the position on:
    // the refused change is pulled again once the kit can read it.
    pulled[0]({ changes: new Uint8Array([4, 5, 6]), seq: 7 })
    await vi.waitFor(() => expect(replica.importChanges).toHaveBeenCalledTimes(2))
    await flush()
    expect(readRoom('doc-1')?.seen).toBeUndefined()
    expect(readRoom('doc-1')?.role).toBe('editor')
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
