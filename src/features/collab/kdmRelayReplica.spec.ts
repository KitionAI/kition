import { describe, expect, it, vi } from 'vitest'
import { person, Replica } from '@/lib/kdm'
import { startRelay, type ConnectionState, type RelaySync, type RoomJoinResult } from '@/lib/sync'
import { LORO_REPLICA_VERSIONS } from '@/lib/sync/replicaVersions'
import { createDocumentReplica, documentBody } from '@kition/document-editor/model'
import { DOCUMENT_BODY } from '@kition/document-editor/model'
import { kdmRelayReplica, type KdmReplicaHost } from './kdmRelayReplica'

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

  it('relays edits between two replicas both ways', async () => {
    const created = createDocumentReplica('Hello\n', 1n)
    const other = Replica.load(created.replica.schema, created.replica.snapshot(), 2n)
    const host = (replica: Replica): KdmReplicaHost => ({
      replica: () => replica,
      importChanges: (changes) => void replica.importChanges(changes),
      subscribe: (listener) => replica.subscribeText(created.rootId, DOCUMENT_BODY, () => listener()),
    })
    const room = new Room()
    const relays = [created.replica, other].map((replica) => startRelay({ docId: replica.docId, replica: kdmRelayReplica(host(replica)), sync: new RoomClient(room), versions: LORO_REPLICA_VERSIONS }))
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) await Promise.all(relays.map((relay) => relay.idle()))
    }
    await settle()
    created.replica.transact(person('user:a'), (tx) => tx.textInsert(created.rootId, DOCUMENT_BODY, 0, 'A'))
    other.transact(person('user:b'), (tx) => tx.textInsert(created.rootId, DOCUMENT_BODY, 5, 'B'))
    await settle()
    for (const replica of [created.replica, other]) expect(documentBody(replica, created.rootId)).toBe('AHelloB\n')
    expect(created.replica.version().equals(other.version())).toBe(true)
    for (const relay of relays) relay.stop()
  })
})
