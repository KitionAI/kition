import { describe, expect, it, vi } from 'vitest'
import { person, Replica } from '@/lib/kdm'
import { startRelay, type ConnectionState, type RelaySync, type RoomJoinResult } from '@/lib/sync'
import { LORO_REPLICA_VERSIONS } from '@/lib/sync/replicaVersions'
import { createDocumentReplica, documentBody } from '@kition/document-editor/model'
import { DOCUMENT_BODY } from '@kition/document-editor/model'
import { BoardStore, boardSchema, createBoardElementRecord } from '@kition/board-editor/model'
import { kdmRelayReplica, type KdmReplicaHost } from './kdmRelayReplica'

const rect = (id: string, index: number, pageId: string) => ({
  ...createBoardElementRecord({ element: { id, kind: 'rectangle', x: index * 20, y: 0, width: 10, height: 10 }, index, pageId: '' }),
  page_id: pageId,
})

/** An open board as `openBoards.ts` announces it: its store's replica and merge path. */
function boardHost(store: BoardStore): KdmReplicaHost {
  return { replica: () => store.getReplica(), importChanges: (changes) => store.importChanges(changes), subscribe: (listener) => store.subscribe(listener) }
}

/** Two stores of one board, as two windows have after one opened the other's shared copy. */
function boardPair() {
  const a = new BoardStore()
  const b = new BoardStore(Replica.load(boardSchema, a.snapshot(), 7n))
  return { a, b }
}

/** A sync room in memory: pushes go to every other joined client, `seq` counts them. */
class Room {
  readonly log: Uint8Array[] = []
  readonly clients = new Set<RoomClient>()
}

class RoomClient implements RelaySync {
  state: ConnectionState = 'online'
  private readonly listeners = new Set<(notice: { changes: Uint8Array; seq?: number }) => void>()

  constructor(private readonly room: Room) {
    room.clients.add(this)
  }

  async join(_docId: string, since?: number | null): Promise<RoomJoinResult> {
    return { changes: this.room.log.slice(since ?? 0), seq: this.room.log.length, more: false, presence: [], role: 'editor' }
  }

  leave() {}

  async push(_docId: string, changes: Uint8Array) {
    this.room.log.push(changes)
    const seq = this.room.log.length
    for (const client of this.room.clients) if (client !== this) for (const listener of client.listeners) listener({ changes, seq })
    return { seq }
  }

  onChanges(_docId: string, listener: (notice: { changes: Uint8Array; seq?: number }) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onState() {
    return () => undefined
  }

  readonly blobs = {
    has: async (_docId: string, hashes: string[]) => ({ missing: hashes }),
    put: async () => ({ hash: '' }),
    get: async (): Promise<{ data: Uint8Array; mime: string }> => {
      throw new Error('no blobs')
    },
  }
}

describe('kdmRelayReplica over an open board', () => {
  it('exports a commit, imports it into the other board as a merge that is no undo step', async () => {
    const { a, b } = boardPair()
    const sideA = kdmRelayReplica(boardHost(a))
    const sideB = kdmRelayReplica(boardHost(b))
    const since = await sideB.version()
    a.transact('add', (tx) => tx.put(rect('shape-1', 0, a.getCurrentPageId())))
    const exported = await sideA.exportChanges(since)
    expect(new Uint8Array(exported.blobs).length).toBe(0)
    const undoBefore = b.getSnapshot().canUndo
    await sideB.importChanges(exported.changes, exported.blobs)
    expect(b.getRecord('shape-1')).not.toBeNull()
    expect(b.getSnapshot().canUndo).toBe(undoBefore)
    expect(b.undo()).toBeNull()
    expect(b.getRecord('shape-1')).not.toBeNull()
  })

  it('reports a new replica version, never a view-only change', () => {
    const { a } = boardPair()
    const changed = vi.fn()
    const stop = kdmRelayReplica(boardHost(a)).onChanged(changed)
    a.setActivePage(a.getCurrentPageId())
    const live = a.beginTransaction('move', { live: true })
    live.put(rect('shape-1', 0, a.getCurrentPageId()))
    expect(changed).not.toHaveBeenCalled()
    live.commit()
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
    a.transact('add', (tx) => tx.put(rect('shape-2', 1, a.getCurrentPageId())))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('relays edits between two boards both ways', async () => {
    const { a, b } = boardPair()
    const room = new Room()
    const relays = [a, b].map((store) => startRelay({ docId: store.getReplica().docId, replica: kdmRelayReplica(boardHost(store)), sync: new RoomClient(room), versions: LORO_REPLICA_VERSIONS }))
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) await Promise.all(relays.map((relay) => relay.idle()))
    }
    await settle()
    a.transact('add', (tx) => tx.put(rect('from-a', 0, a.getCurrentPageId())))
    b.transact('add', (tx) => tx.put(rect('from-b', 1, b.getCurrentPageId())))
    await settle()
    for (const store of [a, b]) {
      expect(store.getRecord('from-a')).not.toBeNull()
      expect(store.getRecord('from-b')).not.toBeNull()
    }
    expect(a.getReplica().version().equals(b.getReplica().version())).toBe(true)
    for (const relay of relays) relay.stop()
  })

  it('commits nothing on a read-only board, and still takes merges', async () => {
    const { a, b } = boardPair()
    b.setReadOnly(true)
    const version = b.getReplica().version()
    expect(b.transact('add', (tx) => tx.put(rect('blocked', 0, b.getCurrentPageId())))).toBeNull()
    expect(b.getRecord('blocked')).toBeNull()
    expect(b.getReplica().version().equals(version)).toBe(true)
    a.transact('add', (tx) => tx.put(rect('from-a', 0, a.getCurrentPageId())))
    const sideB = kdmRelayReplica(boardHost(b))
    const exported = await kdmRelayReplica(boardHost(a)).exportChanges(await sideB.version())
    await sideB.importChanges(exported.changes, exported.blobs)
    expect(b.getRecord('from-a')).not.toBeNull()
  })
})

describe('kdmRelayReplica over a Markdown document', () => {
  it('merges concurrent typing character by character', async () => {
    const created = createDocumentReplica('Hello world\n', 1n)
    const other = Replica.load(created.replica.schema, created.replica.snapshot(), 2n)
    const host = (replica: Replica): KdmReplicaHost => ({
      replica: () => replica,
      importChanges: (changes) => void replica.importChanges(changes),
      subscribe: (listener) => replica.subscribeText(created.rootId, DOCUMENT_BODY, () => listener()),
    })
    const sideA = kdmRelayReplica(host(created.replica))
    const sideB = kdmRelayReplica(host(other))
    const base = await sideA.version()
    created.replica.transact(person('user:a'), (tx) => tx.textInsert(created.rootId, DOCUMENT_BODY, 5, ','))
    other.transact(person('user:b'), (tx) => tx.textInsert(created.rootId, DOCUMENT_BODY, 11, '!'))
    const fromA = await sideA.exportChanges(base)
    const fromB = await sideB.exportChanges(base)
    await sideB.importChanges(fromA.changes, fromA.blobs)
    await sideA.importChanges(fromB.changes, fromB.blobs)
    expect(documentBody(created.replica, created.rootId)).toBe('Hello, world!\n')
    expect(documentBody(other, created.rootId)).toBe('Hello, world!\n')
  })
})
