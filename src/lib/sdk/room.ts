// Copied from kition-sdk packages/sdk/src/room.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The object model over the sync protocol (`kition-sync/1`, kition-sdk docs/platform/reference/sync-protocol.md): a document in
 * a server room, with no kit and no page. `openRoom` joins the room with a `SyncClient`, keeps a
 * KDM replica of it here (from the room's snapshot and changes), and runs each batch on that
 * replica: a run of model operations becomes one change, which the room must take (`changes/push`)
 * before the replica keeps it. Changes other members push come in as `changes/pull` and fire
 * `changed`.
 *
 * Commands need the kit's engine. A server that runs kits headless (it lists `headless`, protocol
 * 1.7) runs each `command` operation as `agent/run`, and the batch goes on once the change the
 * command made has arrived; any other server refuses commands (`command-failed`).
 *
 * The room's role decides what a batch may do: a `viewer`'s batches only read (`read-only`), a
 * `commenter`'s may change only `CommentThread` and `Comment` objects (rule M23), refused here
 * before they reach the server.
 */
import {
  BatchError,
  ChangeAudit,
  describeModel,
  parseSchema,
  randomActor,
  Replica,
  runBatch,
  touchesOnlyComments,
  type BatchErrorCode,
  type BatchRequest,
  type BatchResult,
  type BatchTarget,
  type Origin,
  type Schema,
} from '../kdm'
import {
  HEADLESS_CAPABILITY,
  SyncClient,
  SyncRpcError,
  type ClientInfo,
  type HelloResult,
  type Presence,
  type Principal,
  type Role,
  type SyncToken,
  type SyncTransport,
  type TransportFactory,
} from '../sync'
import { ModelDocument, type ModelBackend } from './document'
import type { ModelDescription } from './exchange'
import { kitDescriptor } from './kits'
import type { DocumentEventSource, KitCommandInfo, PresenceEvent } from './port'
import type { CommandMap, ModelObject } from './proxy'

export type RoomOptions = {
  /**
   * The sync server: its WebSocket endpoint (`wss://pro.kition.ai/v1/sync`), or its `http(s)://`
   * address, whose root stands for `/v1/sync` (Kition Pro's endpoint).
   */
  server: string
  /** The person's token for `sync/hello`. */
  token?: string
  /** Answers a token on every connection attempt (reconnects too), for a short-lived token. */
  tokenProvider?: () => string | Promise<string>
  /** The room's document id, for a room this person is already a member of. */
  docId?: string
  /** A share link to the room (`room/open`); it names the room's kit too. */
  shareLink?: string
  /** The room's kit id; required with `docId`, checked against the room's with `shareLink`. */
  kit?: string
  /** The kit's schema; by default the one registered for the kit's id (`registerKit`, `@kition/sdk/kits`). */
  schema?: Schema | object
  /** The origin every batch carries; `extension`/`script` by default. */
  origin?: Origin
  /** Who this client is in `sync/hello`. */
  client?: ClientInfo
  /** The connection; by default the global `WebSocket` (a page, Node 22 and later). */
  createTransport?: TransportFactory
  /** How long a command waits for the change the server's agent made (milliseconds; 30 000). */
  commandTimeout?: number
  /** Hears what goes wrong outside a batch (a change from the room that does not import); `console.error` by default. */
  onError?: (error: unknown) => void
}

/** A WebSocket as a `SyncTransport` (binary frames as `ArrayBuffer`s). */
export function webSocketTransport(url: string): SyncTransport {
  const Socket = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket
  if (!Socket) throw new Error('no global WebSocket here (Node 22 or later has one): pass createTransport')
  const socket = new Socket(url)
  socket.binaryType = 'arraybuffer'
  return socket as unknown as SyncTransport
}

/** The WebSocket endpoint for `server`: a `ws(s)://` URL as it is, an `http(s)://` one with `/v1/sync` for an empty path. */
export function syncEndpoint(server: string): string {
  const url = new URL(server)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1/sync'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`${server} is no sync server address (ws://, wss://, http://, or https://)`)
  }
  return url.toString()
}

const ROLE_REFUSALS: Record<Role, string | null> = {
  owner: null,
  editor: null,
  commenter: 'a commenter may change only comments (CommentThread and Comment objects)',
  viewer: 'a viewer may only read the room',
}

/** A refusal from the server as a `BatchError`. */
function refusal(error: unknown, what: string): BatchError {
  if (error instanceof BatchError) return error
  const message = error instanceof Error ? error.message : String(error)
  const reason = error instanceof SyncRpcError ? error.reason : undefined
  const code: BatchErrorCode = reason === 'forbidden' ? 'read-only' : 'invalid-value'
  return new BatchError(code, null, `${what}: ${message}`)
}

/** The live state of one joined room, and the object model's backend over it. */
class Room implements ModelBackend, DocumentEventSource {
  readonly events = ['presence'] as const
  readonly schema: Schema
  private replica: Replica | null = null
  private early: Uint8Array[] = []
  private readonly actor = randomActor()
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<(version: Uint8Array | null) => void>()
  private roleListeners = new Set<(role: Role | null) => void>()
  private waiters: Array<{ seq: number; done: () => void }> = []
  private unsubscribes: Array<() => void> = []
  /** The highest room `seq` this replica has every change up to. */
  private seen = 0
  /** The replica's version after this handle's last batch. */
  private own: Uint8Array | null = null
  role: Role | null = null
  presence: Presence[] = []
  /** Removed from the room by its owner (`room/access`): the handle reads what it has, and writes nothing. */
  removed = false
  /** Left the room (`close`). */
  left = false

  constructor(
    readonly sync: SyncClient,
    readonly docId: string,
    readonly kitId: string,
    schema: Schema | object,
    private readonly hello: HelloResult,
    private readonly options: RoomOptions,
  ) {
    this.schema = 'types' in schema && 'root' in schema && 'kit' in schema ? parseSchema(schema) : (schema as Schema)
  }

  /** Joins the room and loads its document. */
  async join(): Promise<void> {
    this.unsubscribes.push(
      this.sync.onChanges(this.docId, (notice) => this.receive(notice.changes, notice.seq)),
      this.sync.onPresence(this.docId, (peers) => {
        this.presence = peers
      }),
      this.sync.onAccess(this.docId, (role) => {
        this.role = role
        if (role === null) this.removed = true
        for (const listener of [...this.roleListeners]) listener(role)
      }),
    )
    const joined = await this.sync.join(this.docId, null)
    this.role = joined.role
    this.presence = joined.presence
    let changes = joined.changes
    let base: Uint8Array
    if (joined.snapshot) {
      base = changes[0]
      changes = changes.slice(1)
    } else {
      // A member of the room may read its snapshot; the changes after it came with the join.
      base = (await this.sync.snapshot(this.docId)).snapshot
    }
    const replica = Replica.load(this.schema, base, this.actor)
    for (const change of [...changes, ...this.early]) replica.importChanges(change)
    this.early = []
    this.replica = replica
    this.reach(joined.seq)
  }

  private receive(changes: Uint8Array, seq: number | undefined) {
    if (!this.replica) {
      this.early.push(changes)
      return
    }
    const before = this.replica.version()
    try {
      this.replica.importChanges(changes)
    } catch (error) {
      const report = this.options.onError ?? ((failure: unknown) => console.error('[kition-sdk] a change from the room did not import', failure))
      report(error)
    }
    // A catch-up after a reconnect carries no `seq`, and reaches the room's latest.
    this.reach(seq ?? Number.MAX_SAFE_INTEGER)
    const after = this.replica.version()
    if (after.equals(before)) return
    const encoded = after.encode()
    for (const listener of [...this.listeners]) listener(encoded)
  }

  private reach(seq: number) {
    if (seq > this.seen) this.seen = seq
    const ready = this.waiters.filter((waiter) => waiter.seq <= this.seen)
    this.waiters = this.waiters.filter((waiter) => waiter.seq > this.seen)
    for (const waiter of ready) waiter.done()
  }

  /** Settles once this replica holds the room's change `seq`. */
  private arrived(seq: number): Promise<void> {
    if (seq <= this.seen) return Promise.resolve()
    const timeout = this.options.commandTimeout ?? 30_000
    return new Promise((resolve, reject) => {
      const waiter = { seq, done: () => (clearTimeout(timer), resolve()) }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((other) => other !== waiter)
        reject(new Error(`the change the command made (seq ${seq}) did not arrive within ${timeout} ms`))
      }, timeout)
      this.waiters.push(waiter)
    })
  }

  private loaded(): Replica {
    if (this.left) throw new BatchError('read-only', null, 'this room handle has left the room')
    if (!this.replica) throw new BatchError('not-found', null, 'the room is not joined yet')
    return this.replica
  }

  /** What the server lists in `sync/hello`: protocol features and capability sets. */
  get capabilities(): readonly string[] {
    return this.hello.capabilities
  }

  /** Whether the server runs the room's kit commands (`agent/run`). */
  get runsCommands(): boolean {
    return this.hello.capabilities.includes(HEADLESS_CAPABILITY)
  }

  private target(): BatchTarget {
    return {
      replica: () => this.loaded(),
      readOnly: () => this.removed || this.role === null || this.role === 'viewer',
      transact: async (origin, write) => {
        const replica = this.loaded()
        const base = replica.version()
        // The batch's writes go to a draft first: the replica keeps them once the room has.
        const draft = replica.fork(this.actor)
        draft.transact(origin, write)
        if (draft.version().equals(base)) return
        const changes = draft.exportChanges(base)
        if (this.role === 'commenter' && !touchesOnlyComments(ChangeAudit.load(replica.exportChanges()).touched(changes))) {
          throw new BatchError('read-only', null, ROLE_REFUSALS.commenter!)
        }
        let seq: number
        try {
          seq = (await this.sync.push(this.docId, changes)).seq
        } catch (error) {
          throw refusal(error, 'the room refused the changes')
        }
        replica.importChanges(changes)
        this.reach(seq)
      },
      command: async (id, params) => {
        const refused = this.removed || !this.role ? 'not a member of the room' : this.role === 'commenter' ? 'a commenter may not run commands (the server runs them for an owner or an editor)' : ROLE_REFUSALS[this.role]
        if (refused) throw new Error(refused)
        if (!this.runsCommands) {
          throw new Error(`\`${id}\` needs the kit's engine: this sync server runs no kits (it does not list \`headless\`), so a room handle runs only model operations`)
        }
        let answer
        try {
          answer = await this.sync.runAgent(this.docId, { ops: [{ op: 'command', id, params }] })
        } catch (error) {
          const model = (error as { data?: { model?: { message?: unknown } } }).data?.model
          throw new Error(typeof model?.message === 'string' ? model.message : error instanceof Error ? error.message : String(error))
        }
        if (answer.seq !== null) await this.arrived(answer.seq)
        return ((answer.result as BatchResult | null)?.results ?? [])[0] ?? null
      },
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  batch(request: BatchRequest): Promise<BatchResult> {
    return this.serial(async () => {
      try {
        return await runBatch(this.target(), request)
      } finally {
        if ((request.ops?.length ?? 0) > 0 && this.replica) this.own = this.replica.version().encode()
      }
    })
  }

  describe(): Promise<ModelDescription> {
    return this.serial(async () => ({ ...describeModel(this.loaded()), commands: [] }))
  }

  /** The kit's catalogue does not travel over the sync protocol: a room lists no commands. */
  async commands(): Promise<KitCommandInfo[]> {
    return []
  }

  /** The document's version after this handle's last batch (`changed` from the room is told apart by it). */
  version(): Uint8Array | null {
    return this.own
  }

  onChanged(listener: (version: Uint8Array | null) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onRole(listener: (role: Role | null) => void): () => void {
    this.roleListeners.add(listener)
    return () => {
      this.roleListeners.delete(listener)
    }
  }

  on: NonNullable<DocumentEventSource['on']> = (event, listener) => {
    if (event !== 'presence') return () => undefined
    const heard = listener as (value: PresenceEvent) => void
    return this.sync.onPresence(this.docId, (peers) => heard({ peers }))
  }

  /** The room's document as it stands here, as one snapshot. */
  snapshot(): Uint8Array {
    return this.loaded().snapshot()
  }

  leave() {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    for (const waiter of this.waiters.splice(0)) waiter.done()
    this.listeners.clear()
    this.roleListeners.clear()
    if (!this.left) this.sync.leave(this.docId)
    this.left = true
  }
}

/** A document in a server room, opened for scripting (`openRoom`). */
export class RoomDocument<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap> extends ModelDocument<Root, C> {
  constructor(
    private readonly room: Room,
    origin: Origin | undefined,
    private readonly ownsClient: boolean,
  ) {
    super(room, origin)
  }

  /** The room's document id. */
  get docId(): string {
    return this.room.docId
  }

  /** This person's role in the room (`null` once removed from it). */
  get role(): Role | null {
    return this.room.role
  }

  /** Who the server says this person is. */
  get principal(): Principal | undefined {
    return this.room.sync.principal
  }

  /** The people in the room, as last heard. */
  get peers(): readonly Presence[] {
    return this.room.presence
  }

  /** Whether the server runs kit commands for this room (`agent/run`); without, a `command` operation is refused. */
  get runsCommands(): boolean {
    return this.room.runsCommands
  }

  /** What the server lists in `sync/hello` (test one with `supports(set, doc.capabilities)`). */
  get capabilities(): readonly string[] {
    return this.room.capabilities
  }

  /** The sync client the room is joined with (presence, leases, previews, history). */
  get sync(): SyncClient {
    return this.room.sync
  }

  /** Hears this person's role change; `null`: they were removed, and the handle only reads what it has. */
  onRole(listener: (role: Role | null) => void): () => void {
    return this.room.onRole(listener)
  }

  /** The room's document as this handle holds it, as a KDM snapshot. */
  snapshot(): Uint8Array {
    return this.room.snapshot()
  }

  /** Leaves the room and, when `openRoom` made the connection, closes it. */
  override close() {
    super.close()
    this.room.leave()
    // After `room/leave` has gone out.
    if (this.ownsClient) queueMicrotask(() => this.room.sync.close())
  }
}

export type CreateRoomOptions = Pick<RoomOptions, 'server' | 'token' | 'tokenProvider' | 'schema' | 'client' | 'createTransport'> & {
  /** The document's kit id. */
  kit: string
  /** The room's name, as its members see it. */
  name: string
  /** The document as a KDM snapshot or a full change export (a kit engine's `exportChanges` from nothing). */
  document: Uint8Array
}

/**
 * Shares a document as a new room on a sync server (`room/create`, Kition Pro: a Pro account):
 * answers its `docId` and an editing share link. The person creating it is the room's owner.
 */
export async function createRoom(options: CreateRoomOptions): Promise<{ docId: string; shareLink: string }> {
  const token: SyncToken | undefined = options.tokenProvider ?? options.token
  if (token === undefined) throw new Error('createRoom takes a token or a tokenProvider')
  const schema = options.schema ?? kitDescriptor(options.kit)?.schema
  if (!schema) throw new Error(`no schema for ${options.kit}: pass options.schema or registerKit() its descriptor`)
  const parsed = 'types' in schema && 'root' in schema && 'kit' in schema ? parseSchema(schema) : (schema as Schema)
  const replica = Replica.load(parsed, options.document, randomActor())
  const sync = new SyncClient({ createTransport: options.createTransport ?? webSocketTransport, client: options.client ?? { name: '@kition/sdk', version: '0.1.0' } })
  try {
    await sync.connect(syncEndpoint(options.server), token)
    const { shareLink } = await sync.createRoom(replica.docId, replica.snapshot(), options.name, options.kit)
    return { docId: replica.docId, shareLink }
  } finally {
    sync.close()
  }
}

/**
 * Opens a document in a sync server's room for scripting: `{ server, token | tokenProvider,
 * docId | shareLink, kit }`. Answers once the room is joined and its document loaded; `close()`
 * leaves the room.
 */
export async function openRoom<Root extends ModelObject = ModelObject, C extends CommandMap = CommandMap>(options: RoomOptions): Promise<RoomDocument<Root, C>> {
  if ((options.docId === undefined) === (options.shareLink === undefined)) throw new Error('openRoom takes a docId or a shareLink')
  const token: SyncToken | undefined = options.tokenProvider ?? options.token
  if (token === undefined) throw new Error('openRoom takes a token or a tokenProvider')
  if (options.docId !== undefined && !options.kit) throw new Error("openRoom with a docId takes the room's kit too")
  const sync = new SyncClient({ createTransport: options.createTransport ?? webSocketTransport, client: options.client ?? { name: '@kition/sdk', version: '0.1.0' } })
  try {
    const hello = await sync.connect(syncEndpoint(options.server), token)
    let docId = options.docId
    let kit = options.kit
    if (options.shareLink !== undefined) {
      const opened = await sync.openRoom(options.shareLink)
      if (kit && kit !== opened.kit) throw new Error(`the share link opens a ${opened.kit} room, not ${kit}`)
      docId = opened.docId
      kit = opened.kit
    }
    const schema = options.schema ?? kitDescriptor(kit!)?.schema
    if (!schema) throw new Error(`no schema for ${kit}: pass options.schema or registerKit() its descriptor`)
    const room = new Room(sync, docId!, kit!, schema, hello, options)
    await room.join()
    return new RoomDocument<Root, C>(room, options.origin, true)
  } catch (error) {
    sync.close()
    throw error
  }
}
