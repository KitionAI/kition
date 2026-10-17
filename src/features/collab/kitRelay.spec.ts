import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ConnectionState, RoomJoinResult } from '@/lib/sync'
import { decodeBlobSection, encodeBlobSection } from './blobSection'
import { startKitRelay, type RelayReplica, type RelaySync } from './kitRelay'
import type { ReplicaVersions } from './replicaVersions'

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const parse = <T>(bytes: ArrayBuffer | Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

type Op = { id: string; blob: string | null }

/** A replica as a set of operations, each needing at most one blob; a version is the set of op ids. */
class FakeReplica implements RelayReplica {
  readonly ops = new Map<string, Op>()
  readonly blobs = new Map<string, Uint8Array>()
  private readonly listeners = new Set<(version: ArrayBuffer) => void>()

  constructor(ops: Op[] = []) {
    for (const op of ops) this.ops.set(op.id, op)
  }

  /** A local edit, as a person makes it in the kit's editor; the kit then reports `replica/changed`. */
  edit(id: string, blob?: string) {
    let hash: string | null = null
    if (blob) {
      const data = new TextEncoder().encode(blob)
      hash = sha256(data)
      this.blobs.set(hash, data)
    }
    this.ops.set(id, { id, blob: hash })
    this.changed()
  }

  ids() {
    return [...this.ops.keys()].sort()
  }

  private changed() {
    const version = buffer(text(this.ids()))
    for (const listener of this.listeners) listener(version)
  }

  async version() {
    return buffer(text(this.ids()))
  }

  async exportChanges(since: ArrayBuffer) {
    const known = new Set(since.byteLength ? parse<string[]>(since) : [])
    const ops = [...this.ops.values()].filter((op) => !known.has(op.id))
    const blobs = ops.flatMap((op) => (op.blob ? [{ hash: op.blob, data: this.blobs.get(op.blob)! }] : []))
    return { changes: buffer(text({ ops })), blobs: buffer(encodeBlobSection(blobs)) }
  }

  async importChanges(changes: ArrayBuffer, blobs: ArrayBuffer) {
    for (const entry of decodeBlobSection(new Uint8Array(blobs))) this.blobs.set(entry.hash, entry.data)
    const { ops } = parse<{ ops: Op[] }>(changes)
    for (const op of ops) if (op.blob && !this.blobs.has(op.blob)) throw new Error(`missing blob ${op.blob}`)
    const fresh = ops.filter((op) => !this.ops.has(op.id))
    for (const op of fresh) this.ops.set(op.id, op)
    if (fresh.length) this.changed()
    return { damage: null }
  }

  onChanged(listener: (version: ArrayBuffer) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const FAKE_VERSIONS: ReplicaVersions = {
  isEmpty: (changes) => parse<{ ops: Op[] }>(changes).ops.length === 0,
  merge: (a, b) => text([...new Set([...(a.length ? parse<string[]>(a) : []), ...(b.length ? parse<string[]>(b) : [])])].sort()),
  endOf: (changes) => text(parse<{ ops: Op[] }>(changes).ops.map((op) => op.id)),
  includes: (version, other) => {
    const held = new Set(version.length ? parse<string[]>(version) : [])
    return (other.length ? parse<string[]>(other) : []).every((id) => held.has(id))
  },
}

/** A sync server holding one room: its change log and the blob store. */
class FakeServer {
  readonly log: Uint8Array[] = []
  readonly blobs = new Map<string, Uint8Array>()
  readonly events: string[] = []
  readonly clients = new Set<FakeClient>()

  client() {
    const client = new FakeClient(this)
    this.clients.add(client)
    return client
  }
}

const unavailable = () => new Error('disconnected')

/** A `SyncClient` as the relay sees it: pushes made offline wait in a queue; reconnecting re-joins, then sends them. */
class FakeClient implements RelaySync {
  state: ConnectionState = 'online'
  readonly queued: Array<{ changes: Uint8Array; resolve: (result: { seq: number }) => void }> = []
  private readonly joined = new Set<string>()
  private lastSeq = 0
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly changeListeners = new Set<(notice: { changes: Uint8Array; seq?: number }) => void>()

  constructor(private readonly server: FakeServer) {}

  /** The `since` of every `join`, for tests to inspect. */
  readonly joins: Array<number | null | undefined> = []

  async join(docId: string, since?: number | null): Promise<RoomJoinResult> {
    if (this.state !== 'online') throw unavailable()
    this.joins.push(since)
    this.joined.add(docId)
    if (since !== undefined) this.lastSeq = since ?? 0
    const changes = this.server.log.slice(this.lastSeq)
    this.lastSeq = this.server.log.length
    return { changes, seq: this.lastSeq, more: false, presence: [], role: 'editor' }
  }

  leave(docId: string) {
    this.joined.delete(docId)
  }

  push(_docId: string, changes: Uint8Array) {
    return new Promise<{ seq: number }>((resolve) => {
      if (this.state === 'online') this.send(changes, resolve)
      else this.queued.push({ changes, resolve })
    })
  }

  private send(changes: Uint8Array, resolve: (result: { seq: number }) => void) {
    this.server.log.push(changes)
    this.server.events.push(`push ${new TextDecoder().decode(changes)}`)
    const seq = this.server.log.length
    this.lastSeq = Math.max(this.lastSeq, seq)
    for (const other of this.server.clients) if (other !== this) other.pulled(changes, seq)
    resolve({ seq })
  }

  pulled(changes: Uint8Array, seq: number) {
    if (this.state !== 'online' || !this.joined.size) return
    this.lastSeq = Math.max(this.lastSeq, seq)
    for (const listener of this.changeListeners) listener({ changes, seq })
  }

  onChanges(_docId: string, listener: (notice: { changes: Uint8Array; seq?: number }) => void) {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  onState(listener: (state: ConnectionState) => void) {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  readonly blobs = {
    has: async (hashes: string[]) => {
      if (this.state !== 'online') throw unavailable()
      return { missing: hashes.filter((hash) => !this.server.blobs.has(hash)) }
    },
    put: async (data: Uint8Array) => {
      if (this.state !== 'online') throw unavailable()
      const hash = sha256(data)
      this.server.blobs.set(hash, data)
      this.server.events.push(`put ${hash}`)
      return { hash }
    },
    get: async (hash: string) => {
      if (this.state !== 'online') throw unavailable()
      const data = this.server.blobs.get(hash)
      if (!data) throw new Error('not-found')
      return { data, mime: 'application/octet-stream' }
    },
  }

  setState(state: ConnectionState) {
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }

  /** As `SyncClient` reconnecting: online, re-join (catching up on what was missed), then the queued pushes. */
  reconnect() {
    this.setState('online')
    if (this.joined.size) {
      const missed = this.server.log.slice(this.lastSeq)
      this.lastSeq = this.server.log.length
      for (const changes of missed) for (const listener of this.changeListeners) listener({ changes })
    }
    for (const item of this.queued.splice(0)) this.send(item.changes, item.resolve)
  }
}

const SHARED: Op[] = [{ id: 'base', blob: null }]

async function setUp() {
  const server = new FakeServer()
  const sides = ['a', 'b'].map(() => {
    const replica = new FakeReplica(SHARED)
    const sync = server.client()
    const relay = startKitRelay({ docId: 'doc', replica, sync, versions: FAKE_VERSIONS, lastSent: text(['base']) })
    return { replica, sync, relay }
  })
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await Promise.all(sides.map((side) => side.relay.idle()))
  }
  await settle()
  return { server, a: sides[0], b: sides[1], settle }
}

describe('startKitRelay', () => {
  it('pushes a local edit to the room, its blob uploaded first', async () => {
    const { server, a, settle } = await setUp()
    a.replica.edit('a1', 'a brush stroke')
    await settle()
    const hash = sha256(new TextEncoder().encode('a brush stroke'))
    expect(server.log).toHaveLength(1)
    expect(parse<{ ops: Op[] }>(server.log[0]).ops.map((op) => op.id)).toEqual(['a1'])
    expect(server.events.map((event) => event.split(' ')[0])).toEqual(['put', 'push'])
    expect(server.blobs.has(hash)).toBe(true)
  })

  it('imports another person’s change with the blobs it needs, and does not send it back', async () => {
    const { server, a, b, settle } = await setUp()
    a.replica.edit('a1', 'a brush stroke')
    await settle()
    expect(b.replica.ids()).toEqual(['a1', 'base'])
    expect(b.replica.blobs.has(sha256(new TextEncoder().encode('a brush stroke')))).toBe(true)
    // B's import moved its version, and its relay looked: nothing of its own to send.
    expect(server.log).toHaveLength(1)
    b.replica.edit('b1')
    await settle()
    expect(a.replica.ids()).toEqual(['a1', 'b1', 'base'])
    expect(server.log).toHaveLength(2)
  })

  it('keeps edits made offline (queued pushes, unsent blobs) and converges once back', async () => {
    const { server, a, b, settle } = await setUp()
    b.sync.setState('offline')
    // An edit without blobs is pushed into the client's queue; one with a blob waits for the connection.
    b.replica.edit('b1')
    await settle()
    expect(b.sync.queued).toHaveLength(1)
    b.replica.edit('b2', 'an offline stroke')
    a.replica.edit('a1', 'a stroke meanwhile')
    await settle()
    expect(b.sync.queued).toHaveLength(1)
    expect(a.replica.ids()).toEqual(['a1', 'base'])

    b.sync.reconnect()
    await settle()
    expect(a.replica.ids()).toEqual(['a1', 'b1', 'b2', 'base'])
    expect(b.replica.ids()).toEqual(['a1', 'b1', 'b2', 'base'])
    expect(a.replica.blobs.has(sha256(new TextEncoder().encode('an offline stroke')))).toBe(true)
    expect(b.replica.blobs.has(sha256(new TextEncoder().encode('a stroke meanwhile')))).toBe(true)
    expect(server.log.length).toBeLessThanOrEqual(4)
  })

  it('reports the seq it has everything up to, and a later session joins from it', async () => {
    const { server, a, b, settle } = await setUp()
    const seen: Array<{ seq: number; version: string[] }> = []
    const c = { replica: new FakeReplica(SHARED), sync: server.client() }
    const relay = startKitRelay({
      docId: 'doc',
      replica: c.replica,
      sync: c.sync,
      versions: FAKE_VERSIONS,
      lastSent: text(['base']),
      onSeen: ({ seq, version }) => seen.push({ seq, version: parse<string[]>(version) }),
    })
    a.replica.edit('a1')
    b.replica.edit('b1')
    await settle()
    await relay.idle()
    expect(seen.at(-1)).toEqual({ seq: 2, version: ['a1', 'b1', 'base'] })
    relay.stop()

    // Reopened at that version: the join asks only for what came after seq 2.
    a.replica.edit('a2')
    await settle()
    const again = { replica: new FakeReplica([...SHARED, { id: 'a1', blob: null }, { id: 'b1', blob: null }]), sync: server.client() }
    const resumed = startKitRelay({ docId: 'doc', replica: again.replica, sync: again.sync, versions: FAKE_VERSIONS, lastSent: text(['a1', 'b1', 'base']), since: 2 })
    await resumed.idle()
    expect(again.sync.joins).toEqual([2])
    expect(again.replica.ids()).toEqual(['a1', 'a2', 'b1', 'base'])
    resumed.stop()
  })

  it('stops relaying when stopped', async () => {
    const { server, a, settle } = await setUp()
    a.relay.stop()
    a.replica.edit('a1')
    await settle()
    expect(server.log).toHaveLength(0)
  })
})
