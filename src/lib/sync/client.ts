// Copied from kition-sdk packages/sync/src/client.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `SyncClient`: the client side of `kition-sync/1` (docs/sync-protocol.md) over a
 * `SyncTransport`. Reconnects with backoff, re-joins every joined room with the highest server
 * `seq` it last saw for it, and queues pushes made while offline, sending them in order once
 * rejoined.
 */
import { backoffDelay } from './backoff'
import { Decoder, Outgoing, readBin, readBins } from './framing'
import { sha256Hex } from './hash'
import { SyncLeases } from './leases'
import {
  SYNC_PROTOCOL,
  SyncRpcError,
  type AgentRunResult,
  type BlobGetResult,
  type BlobHasResult,
  type ChangesPushResult,
  type ClientInfo,
  type ExportGetResult,
  type HelloResult,
  type HistoryGetResult,
  type HistoryListResult,
  type HistoryRestoreResult,
  type Presence,
  type PreviewGetResult,
  type Role,
  type RoomCreateResult,
  type RoomJoinResult,
  type RoomLinkResult,
  type RoomMembersResult,
  type RoomOpenResult,
  type SnapshotGetResult,
} from './protocol'
import type { ConnectionState, SyncTransport, TransportFactory } from './transport'

export type { ConnectionState } from './transport'

export type SyncClientOptions = {
  createTransport: TransportFactory
  client?: ClientInfo
  capabilities?: string[]
  random?: () => number
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

type PendingRequest = {
  resolve: (result: unknown, bins: Uint8Array[]) => void
  reject: (error: SyncRpcError) => void
  /** Set when this request is a queued push: on disconnect it goes back to the queue instead of failing. */
  push?: QueuedPush
  /** Settles the in-flight `sendPush` wait (not the push's own promise) when it is requeued. */
  onRequeue?: () => void
}
type QueuedPush = { docId: string; changes: Uint8Array; resolve: (result: ChangesPushResult) => void; reject: (error: Error) => void }
type ChangeNotice = { changes: Uint8Array; seq?: number; from?: string }

/** A token, or what answers one: asked again on every connection attempt, so it can refresh. */
export type SyncToken = string | (() => string | Promise<string>)

const disconnected = () => new SyncRpcError(-32000, 'disconnected', { code: 'unavailable' })

export class SyncClient {
  private readonly options: SyncClientOptions
  private url = ''
  private token: SyncToken = ''
  private transport: SyncTransport | undefined
  private decoder = new Decoder()
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private pushQueue: QueuedPush[] = []
  private joined = new Set<string>()
  /** The highest server `seq` seen for each joined doc (join, pull, or push ack), for re-joining
   * after a reconnect without a KDM version of its own. */
  private lastSeq = new Map<string, number>()
  private changesListeners = new Map<string, Set<(notice: ChangeNotice) => void>>()
  private presenceListeners = new Map<string, Set<(peers: Presence[]) => void>>()
  private accessListeners = new Map<string, Set<(role: Role | null) => void>>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private reconnectAttempt = 0
  private reconnectTimer: unknown
  private closed = false
  private readyForPushes = false
  private connectionState: ConnectionState = 'offline'
  private hello: HelloResult | undefined

  constructor(options: SyncClientOptions) {
    this.options = options
  }

  get state(): ConnectionState {
    return this.connectionState
  }

  /** The handshake result from the most recent successful `sync/hello`. */
  get principal() {
    return this.hello?.principal
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /**
   * Connects and performs `sync/hello`; resolves once the handshake succeeds. A `token` function
   * is called for every connection attempt (reconnects too), so a short-lived token is fresh.
   */
  async connect(url: string, token: SyncToken): Promise<HelloResult> {
    this.closed = false
    this.url = url
    this.token = token
    this.reconnectAttempt = 0
    return this.openConnection()
  }

  close(): void {
    this.closed = true
    this.clearReconnectTimer()
    this.transport?.close()
    this.transport = undefined
    this.setState('offline')
    this.failPending(new SyncRpcError(-32000, 'closed', { code: 'unavailable' }))
    for (const item of this.pushQueue.splice(0)) item.reject(new SyncRpcError(-32000, 'closed', { code: 'unavailable' }))
  }

  /**
   * Joins `docId`'s room, or re-joins it after a reconnect. `since` is the server seq the caller
   * already has every change up to (omitted: the highest `seq` this client has itself seen for
   * `docId`, or `null` with none yet, which asks for everything from the room's snapshot).
   *
   * A busy room's catch-up does not fit in one `room/join` reply, so the server pages it (`more`,
   * `docs/sync-protocol.md` section 3); this repeats `room/join` with `since` set to each page's
   * `seq` until `more` is `false`, combining every page's `changes` into the one result this
   * resolves with. `presence` and `role` are from the last page.
   */
  async join(docId: string, since?: number | null): Promise<RoomJoinResult> {
    let nextSince = since === undefined ? this.lastSeq.get(docId) ?? null : since
    const changes: Uint8Array[] = []
    let snapshot = false
    let page: RoomJoinResult
    do {
      page = await this.request<RoomJoinResult>('room/join', () => ({ docId, since: nextSince }), (value, bins) => ({
        changes: readBins(value.changes, bins),
        seq: value.seq as number,
        more: value.more as boolean,
        presence: value.presence as Presence[],
        role: value.role as Role,
        ...(value.snapshot === true ? { snapshot: true } : {}),
      }))
      if (page.snapshot) snapshot = true
      changes.push(...page.changes)
      nextSince = page.seq
    } while (page.more)
    const result: RoomJoinResult = { ...page, changes, ...(snapshot ? { snapshot } : {}) }
    this.joined.add(docId)
    this.bumpSeq(docId, result.seq)
    return result
  }

  leave(docId: string): void {
    this.joined.delete(docId)
    this.leases.left(docId)
    this.sendNotification('room/leave', () => ({ docId }))
  }

  push(docId: string, changes: Uint8Array): Promise<ChangesPushResult> {
    return new Promise((resolve, reject) => {
      const item: QueuedPush = { docId, changes, resolve, reject }
      if (this.readyForPushes) this.sendPush(item)
      else this.pushQueue.push(item)
    })
  }

  onChanges(docId: string, listener: (notice: ChangeNotice) => void): () => void {
    return this.subscribe(this.changesListeners, docId, listener)
  }

  setPresence(docId: string, state: unknown): void {
    this.sendNotification('presence/set', () => ({ docId, state }))
  }

  onPresence(docId: string, listener: (peers: Presence[]) => void): () => void {
    return this.subscribe(this.presenceListeners, docId, listener)
  }

  /** Blobs, scoped to the document whose room uses them (protocol 1.5). */
  /**
   * Leases for coordinated objects (protocol 1.5, `lease/*`): `acquire`, `release`, `hold` (kept
   * renewed), the rooms' lease lists (`list`, `onChanged`), and `mine`. `available` is false while
   * offline or against a server that does not list the `leases` capability.
   */
  readonly leases: SyncLeases = new SyncLeases({
    request: (method, params) => this.request(method, () => params, (value) => value),
    available: () => this.connectionState === 'online' && (this.hello?.capabilities ?? []).includes('leases'),
    // Field initializers run before the constructor sets `options`: read them when used.
    setTimeout: (run, ms) => (this.options.setTimeout ?? ((next: () => void, wait: number) => setTimeout(next, wait)))(run, ms),
    clearTimeout: (handle) => (this.options.clearTimeout ?? ((value: unknown) => clearTimeout(value as number)))(handle),
  })

  readonly blobs = {
    has: (docId: string, hashes: string[]): Promise<BlobHasResult> => this.request('blob/has', () => ({ docId, hashes }), (value) => value as BlobHasResult),

    put: async (docId: string, data: Uint8Array, mime: string): Promise<{ hash: string }> => {
      const hash = await sha256Hex(data)
      await this.request('blob/put', (out) => ({ docId, hash, mime, data: out.bin(data) }), () => ({}))
      return { hash }
    },

    get: async (docId: string, hash: string): Promise<BlobGetResult> => {
      const result = await this.request<BlobGetResult>('blob/get', () => ({ docId, hash }), (value, bins) => ({
        data: readBin(value.data, bins),
        mime: value.mime as string,
      }))
      const actual = await sha256Hex(result.data)
      if (actual !== hash) throw new Error(`blob/get returned data hashing to ${actual}, not the requested ${hash}`)
      return result
    },
  }

  snapshot(docId: string): Promise<SnapshotGetResult> {
    return this.request('snapshot/get', () => ({ docId }), (value, bins) => ({ snapshot: readBin(value.snapshot, bins), seq: value.seq as number }))
  }

  createRoom(docId: string, snapshot: Uint8Array, name: string, kit: string): Promise<RoomCreateResult> {
    return this.request('room/create', (out) => ({ docId, snapshot: out.bin(snapshot), name, kit }), (value) => value as RoomCreateResult)
  }

  /** Resolves `shareLink` to the room it points to; `join(result.docId, ...)` actually joins it. */
  openRoom(shareLink: string): Promise<RoomOpenResult> {
    return this.request('room/open', () => ({ shareLink }), (value) => value as RoomOpenResult)
  }

  /** Mints another share link to `docId`'s room granting `role` (protocol 1.4, `room/link`; `commenter` since 1.6). */
  createLink(docId: string, role: Exclude<Role, 'owner'>): Promise<RoomLinkResult> {
    return this.request('room/link', () => ({ docId, role }), (value) => value as RoomLinkResult)
  }

  /** The room's members and working share links (protocol 1.6, `room/members`; owner or editor). */
  members(docId: string): Promise<RoomMembersResult> {
    return this.request('room/members', () => ({ docId }), (value) => value as RoomMembersResult)
  }

  /** Changes another member's role (protocol 1.6, `room/setRole`; owner only). */
  async setRole(docId: string, principalId: string, role: Exclude<Role, 'owner'>): Promise<void> {
    await this.request('room/setRole', () => ({ docId, principalId, role }), () => undefined)
  }

  /** Removes another member from the room (protocol 1.6, `room/removeMember`; owner only). */
  async removeMember(docId: string, principalId: string): Promise<void> {
    await this.request('room/removeMember', () => ({ docId, principalId }), () => undefined)
  }

  /** Revokes one of the room's share links (protocol 1.6, `room/revokeLink`; owner only). */
  async revokeLink(docId: string, shareLink: string): Promise<void> {
    await this.request('room/revokeLink', () => ({ docId, shareLink }), () => undefined)
  }

  /**
   * Hears this person's role in `docId`'s room change (protocol 1.6, `room/access`): the owner set
   * a new one, or removed them (`null`; the room is then no longer joined, and not re-joined on a
   * reconnect).
   */
  onAccess(docId: string, listener: (role: Role | null) => void): () => void {
    return this.subscribe(this.accessListeners, docId, listener)
  }

  /** The room's history checkpoints, newest first (protocol 1.5, `history/list`). */
  history(docId: string, options: { before?: number; limit?: number } = {}): Promise<HistoryListResult> {
    return this.request('history/list', () => ({ docId, ...options }), (value) => value as HistoryListResult)
  }

  /** The document as of `seq` (protocol 1.5, `history/get`). */
  historyAt(docId: string, seq: number): Promise<HistoryGetResult> {
    return this.request('history/get', () => ({ docId, seq }), (value, bins) => ({ snapshot: readBin(value.snapshot, bins), seq: value.seq as number }))
  }

  /**
   * Restores the joined room's document as of `seq` as one new change (protocol 1.5,
   * `history/restore`); the change arrives as `changes/pull` like anyone else's.
   */
  restore(docId: string, seq: number): Promise<HistoryRestoreResult> {
    return this.request('history/restore', () => ({ docId, seq }), (value) => value as HistoryRestoreResult)
  }

  /**
   * A picture of `docId`'s room as of its latest change, rendered by the kit on a server that runs
   * kits headless (protocol 1.7, `preview/get`; the server lists `headless`).
   */
  preview(docId: string, options: { page?: number; size?: number } = {}): Promise<PreviewGetResult> {
    return this.request(
      'preview/get',
      () => ({ docId, ...options }),
      (value, bins) => ({
        image: readBin(value.image, bins),
        mimeType: value.mimeType as string,
        width: value.width as number,
        height: value.height as number,
        seq: value.seq as number,
      }),
    )
  }

  /** `docId`'s room as a file in `format`, saved by the kit on the server (protocol 1.7, `export/get`). */
  exportFile(docId: string, format?: string): Promise<ExportGetResult> {
    return this.request(
      'export/get',
      () => (format === undefined ? { docId } : { docId, format }),
      (value, bins) => ({ data: readBin(value.data, bins), name: value.name as string, format: value.format as string, seq: value.seq as number }),
    )
  }

  /**
   * Runs an object-model batch on the joined room's document in the server's headless kit, as an
   * agent acting for this person (protocol 1.7, `agent/run`); the change arrives as `changes/pull`.
   */
  runAgent(docId: string, batch: unknown, prompt?: string): Promise<AgentRunResult> {
    return this.request('agent/run', () => (prompt === undefined ? { docId, batch } : { docId, batch, prompt }), (value) => value as AgentRunResult)
  }

  // -- connection lifecycle --------------------------------------------------------------------

  private async openConnection(): Promise<HelloResult> {
    this.setState('connecting')
    this.decoder = new Decoder()
    const transport = this.options.createTransport(this.url)
    this.transport = transport
    return new Promise<HelloResult>((resolve, reject) => {
      transport.onopen = () => {
        this.sendHello().then(resolve, reject)
      }
      transport.onerror = () => {
        /* onclose follows; nothing else to do here */
      }
      transport.onclose = () => {
        this.handleDisconnect()
        reject(disconnected())
      }
      transport.onmessage = (event) => this.handleFrame(event.data)
    })
  }

  private async sendHello(): Promise<HelloResult> {
    const transport = this.transport
    let token: string
    try {
      token = typeof this.token === 'function' ? await this.token() : this.token
    } catch (error) {
      // No token now: drop this attempt, so the next one (with backoff) asks again.
      if (this.transport === transport) transport?.close()
      throw error
    }
    if (this.transport !== transport) throw disconnected()
    const result = await this.request<HelloResult>(
      'sync/hello',
      () => ({ protocol: SYNC_PROTOCOL, token, client: this.options.client ?? { name: '@kition/sync', version: '0.1.0' }, capabilities: this.options.capabilities ?? [] }),
      (value) => value as HelloResult,
    )
    this.hello = result
    this.reconnectAttempt = 0
    this.setState('online')
    await this.rejoinAll()
    this.readyForPushes = true
    await this.flushQueue()
    return result
  }

  /** Re-joins every room this client had joined, each with the highest `seq` it last saw for it
   * (never re-fetching history it already has), and delivers whatever catch-up changes come back. */
  private async rejoinAll(): Promise<void> {
    const docIds = [...this.joined]
    await Promise.allSettled(
      docIds.map(async (docId) => {
        const result = await this.join(docId)
        for (const changes of result.changes) this.emitChanges(docId, { changes })
      }),
    )
  }

  /** Sends every queued push, in order, waiting for each one to settle (or be requeued by a
   * disconnect) before sending the next. */
  private async flushQueue(): Promise<void> {
    while (this.readyForPushes) {
      const item = this.pushQueue.shift()
      if (!item) return
      await this.sendPush(item)
    }
  }

  private handleDisconnect(): void {
    if (this.closed) return
    this.readyForPushes = false
    this.setState('offline')
    this.leases.disconnected()
    // In-flight pushes go back to the front of the queue, in their original order, so a
    // reconnect resends them instead of losing them; their own promise stays pending.
    const inFlightPushes: QueuedPush[] = []
    for (const [id, entry] of [...this.pending]) {
      if (entry.push) {
        inFlightPushes.push(entry.push)
        entry.onRequeue?.()
      } else {
        entry.reject(disconnected())
      }
      this.pending.delete(id)
    }
    this.pushQueue = [...inFlightPushes, ...this.pushQueue]
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = backoffDelay(this.reconnectAttempt, this.options.random)
    this.reconnectAttempt += 1
    const schedule = this.options.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    this.reconnectTimer = schedule(() => {
      this.openConnection().catch(() => {
        /* handleDisconnect (via onclose) schedules the next attempt */
      })
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    const clear = this.options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as number))
    clear(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return
    this.connectionState = state
    for (const listener of this.stateListeners) listener(state)
  }

  private failPending(error: SyncRpcError): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  // -- sending and receiving --------------------------------------------------------------------

  /** Sends one push and resolves once it settles (success, failure, or being requeued by a
   * disconnect) -- never the push's own promise, which stays pending across a requeue. */
  private sendPush(item: QueuedPush): Promise<void> {
    if (!this.transport) {
      this.pushQueue.unshift(item)
      return Promise.resolve()
    }
    const transport = this.transport
    const out = new Outgoing()
    const changes = out.bin(item.changes)
    const id = String(this.nextId++)
    const message = { jsonrpc: '2.0', id, method: 'changes/push', params: { docId: item.docId, changes } }
    return new Promise<void>((settled) => {
      this.pending.set(id, {
        push: item,
        resolve: (result) => {
          const pushResult = result as ChangesPushResult
          this.bumpSeq(item.docId, pushResult.seq)
          item.resolve(pushResult)
          settled()
        },
        reject: (error) => {
          item.reject(error)
          settled()
        },
        onRequeue: settled,
      })
      for (const frame of out.finish(message)) transport.send(frame)
    })
  }

  private request<T>(method: string, buildParams: (out: Outgoing) => Record<string, unknown>, decode: (value: Record<string, unknown>, bins: Uint8Array[]) => T): Promise<T> {
    if (!this.transport) return Promise.reject(disconnected())
    const out = new Outgoing()
    const params = buildParams(out)
    const id = String(this.nextId++)
    const message = { jsonrpc: '2.0', id, method, params }
    const transport = this.transport
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result, bins) => resolve(decode(result as Record<string, unknown>, bins)),
        reject,
      })
      for (const frame of out.finish(message)) transport.send(frame)
    })
  }

  private sendNotification(method: string, buildParams: (out: Outgoing) => Record<string, unknown>): void {
    if (!this.transport || this.connectionState !== 'online') return
    const out = new Outgoing()
    const params = buildParams(out)
    const message = { jsonrpc: '2.0', method, params }
    for (const frame of out.finish(message)) this.transport.send(frame)
  }

  private handleFrame(data: string | ArrayBuffer): void {
    let decoded: { message: Record<string, unknown>; bins: Uint8Array[] } | undefined
    try {
      decoded = this.decoder.feed(typeof data === 'string' ? data : new Uint8Array(data))
    } catch {
      return // a malformed frame is dropped; it never corrupts the decoder's state
    }
    if (!decoded) return
    const { message, bins } = decoded
    if (typeof message.method === 'string' && message.id === undefined) {
      this.handleNotification(message.method, message.params as Record<string, unknown>, bins)
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(String(message.id))
      if (!entry) return
      this.pending.delete(String(message.id))
      if (message.error) entry.reject(toRpcError(message.error as { code: number; message: string; data?: unknown }))
      else entry.resolve(message.result, bins)
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>, bins: Uint8Array[]): void {
    if (method === 'changes/pull') {
      const docId = params.docId as string
      const seq = params.seq as number
      this.bumpSeq(docId, seq)
      this.emitChanges(docId, { changes: readBin(params.changes, bins), seq, from: params.from as string })
      return
    }
    if (method === 'lease/changed') {
      this.leases.receive(params)
      return
    }
    if (method === 'room/access') {
      const docId = params.docId as string
      const role = (params.role ?? null) as Role | null
      if (role === null) {
        this.joined.delete(docId)
        this.leases.left(docId)
      }
      for (const listener of this.accessListeners.get(docId) ?? []) listener(role)
      return
    }
    if (method === 'presence/update') {
      const docId = params.docId as string
      for (const listener of this.presenceListeners.get(docId) ?? []) listener(params.peers as Presence[])
    }
  }

  private emitChanges(docId: string, notice: ChangeNotice): void {
    for (const listener of this.changesListeners.get(docId) ?? []) listener(notice)
  }

  /** Keeps the highest server `seq` seen for `docId`, across joins, pulls, and push acks. */
  private bumpSeq(docId: string, seq: number): void {
    const current = this.lastSeq.get(docId)
    if (current === undefined || seq > current) this.lastSeq.set(docId, seq)
  }

  private subscribe<T>(map: Map<string, Set<T>>, docId: string, listener: T): () => void {
    let set = map.get(docId)
    if (!set) map.set(docId, (set = new Set()))
    set.add(listener)
    return () => set?.delete(listener)
  }
}

function toRpcError(error: { code: number; message: string; data?: unknown }): SyncRpcError {
  return new SyncRpcError(error.code, error.message, error.data)
}
