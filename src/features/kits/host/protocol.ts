// Copied from kition-sdk packages/kit-protocol/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The Kit UI protocol, `kition-kit-ui/1` (docs/ui-protocol.md): its messages, and JSON-RPC 2.0
 * over a MessagePort for both sides. A host and an embedded kit UI each make one `KitPeer` on
 * their end of the channel. Framework-free; no dependencies.
 */

export const KIT_UI_PROTOCOL = 'kition-kit-ui/1'

/**
 * The window messages that connect a host and a kit (`kitionKitUi: 1`, protocol section 2): the
 * kit announces each document it loads (`ready`, with an id of its own), the host asks a kit that
 * may have announced before it listened (`hello`), and answers a `ready` with the handshake that
 * hands the kit its port.
 */
export type KitUiHandshake = { kitionKitUi: 1; protocol: string; id?: string }
export type KitUiReady = { kitionKitUi: 1; ready: string; id: string }
export type KitUiHello = { kitionKitUi: 1; hello: string }

const kitUiMessage = (data: unknown): data is Record<string, unknown> => typeof data === 'object' && data !== null && (data as { kitionKitUi?: unknown }).kitionKitUi === 1

export function isHandshake(data: unknown): data is KitUiHandshake {
  return kitUiMessage(data) && typeof data.protocol === 'string'
}

export function isReady(data: unknown): data is KitUiReady {
  return kitUiMessage(data) && typeof data.ready === 'string' && typeof data.id === 'string'
}

export function isHello(data: unknown): data is KitUiHello {
  return kitUiMessage(data) && typeof data.hello === 'string'
}

/** CSS custom properties the kit applies to its root (protocol section 4). */
export type KitTheme = { colorScheme: 'light' | 'dark'; tokens: Record<string, string> }

export type KitDocumentInit = {
  path: string
  name: string
  /** The file as it is now; absent when `create` asks for a new document. */
  bytes?: ArrayBuffer
  version?: string | null
  readOnly?: boolean
  create?: { width: number; height: number }
  /**
   * Lent files (standard E5): a same-origin URL of the workspace root that serves ranged reads,
   * and the document's folder in it, for the engine's synchronous reads of linked files.
   */
  lend?: { root: string; folder: string }
}

export type InitializeParams = {
  protocol: string
  host: { name: string; version: string }
  document: KitDocumentInit
  theme: KitTheme
  locale: string
  /** The host's own shortcuts, as `Cmd+N`; the kit forwards them (`host/shortcut`). */
  shortcuts: string[]
  /** Optional host methods this host serves: `agent`, `pick-file`, `replica`. */
  capabilities: string[]
}

export type InitializeResult = { kit: { id: string; version: string }; capabilities: string[] }

export type DocumentState = { dirty: boolean; revision: number; title: string }

export type WriteMode = 'save' | 'export' | 'create'

/**
 * A document's replica as the host stores it (capability `replica`, protocol section 7): the KDM
 * snapshot, the blobs it references, and the stamp of the file it was saved with.
 */
export type StoredReplica = { snapshot: ArrayBuffer; blobs: ArrayBuffer; fileStamp: string }

/** Kit AI bridge records (standard A7 to A10), as Kition's runtime defines them. */
export type AiStep = { command: string; params?: Record<string, unknown> }
export type AiRunResult = { completed: Array<{ command: string; changed: boolean; result: unknown }>; saved: boolean }

/** Requests the host sends, with their params and results. */
export type HostToKit = {
  'ui/initialize': [InitializeParams, InitializeResult]
  'document/state': [Record<string, never>, DocumentState]
  'document/save': [Record<string, never>, { saved: boolean; version: string | null }]
  'ai/inspect': [Record<string, never>, Record<string, unknown>]
  'ai/commands': [{ query: string }, Array<Record<string, unknown>>]
  'ai/run': [{ steps: AiStep[]; save: boolean }, AiRunResult]
  'ai/preview': [{ maxSize: number }, { png: string }]
  'replica/version': [Record<string, never>, { version: ArrayBuffer }]
  'replica/export': [{ since: ArrayBuffer }, { changes: ArrayBuffer; blobs: ArrayBuffer }]
  /** `damage` is what went stale on screen, as the kit's engine reports it. */
  'replica/import': [{ changes: ArrayBuffer; blobs: ArrayBuffer }, { damage: unknown }]
}

/** Notifications the host sends. */
export type HostNotifications = {
  'document/fileChanged': { version: string }
  'ui/theme': { theme: KitTheme }
  'ui/locale': { locale: string }
  'ui/focus': Record<string, never>
}

/** Requests the kit sends. */
export type KitToHost = {
  'host/read': [{ path: string; offset?: number; length?: number }, { bytes: ArrayBuffer; version: string; size: number }]
  'host/stamp': [{ path: string }, { version: string | null }]
  'host/write': [{ path: string; bytes: ArrayBuffer; mode: WriteMode; expected?: string | null }, { path: string; version: string }]
  'host/pick': [{ purpose: string; accept: string[] }, { path: string | null }]
  'host/openAgent': [{ prompt?: string }, Record<string, never>]
  'host/replicaRead': [{ path: string }, StoredReplica | null]
  'host/replicaWrite': [{ path: string } & StoredReplica, Record<string, never>]
}

/** Notifications the kit sends. */
export type KitNotifications = {
  'document/changed': DocumentState & { by: 'person' | 'agent' }
  'host/notify': { level: 'info' | 'success' | 'warning' | 'error'; title: string; description?: string }
  'host/shortcut': { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }
  'replica/changed': { version: ArrayBuffer }
}

type Message = { jsonrpc: '2.0'; id?: string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** A failed request: the JSON-RPC error the other side answered. */
export class KitRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
  }
}

type Handler = (params: never) => unknown
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** ArrayBuffers in a value, to transfer instead of copying. */
function transferables(value: unknown, out: Transferable[] = [], depth = 0): Transferable[] {
  if (value instanceof ArrayBuffer) out.push(value)
  else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) out.push(value.buffer)
  else if (value && typeof value === 'object' && depth < 4) for (const item of Object.values(value)) transferables(item, out, depth + 1)
  return out
}

/**
 * One side of the protocol on a MessagePort. `Out` and `In` are the request maps this side sends
 * and answers; `OutN` and `InN` the notifications.
 */
export class KitPeer<
  Out extends Record<string, [unknown, unknown]>,
  In extends Record<string, [unknown, unknown]>,
  OutN extends Record<string, unknown>,
  InN extends Record<string, unknown>,
> {
  private next = 1
  private pending = new Map<string, Pending>()
  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Set<(params: never) => void>>()
  private closed = false

  constructor(private readonly port: MessagePort, private readonly prefix: 'h' | 'k') {
    port.onmessage = (event: MessageEvent<Message>) => void this.receive(event.data)
    port.start()
  }

  /** Answers requests for `method`; a thrown error becomes a JSON-RPC error. */
  handle<M extends keyof In & string>(method: M, handler: (params: In[M][0]) => In[M][1] | Promise<In[M][1]>) {
    this.handlers.set(method, handler as Handler)
  }

  on<M extends keyof InN & string>(method: M, listener: (params: InN[M]) => void) {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(listener as (params: never) => void)
    return () => set.delete(listener as (params: never) => void)
  }

  /** `transfer` hands the params' ArrayBuffers over instead of copying them (the sender loses them). */
  request<M extends keyof Out & string>(method: M, params: Out[M][0], options: { transfer?: boolean } = {}): Promise<Out[M][1]> {
    if (this.closed) return Promise.reject(new KitRpcError(-32000, 'the connection is closed'))
    const id = `${this.prefix}${this.next++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.post({ jsonrpc: '2.0', id, method, params }, options.transfer)
    })
  }

  notify<M extends keyof OutN & string>(method: M, params: OutN[M]) {
    if (!this.closed) this.post({ jsonrpc: '2.0', method, params })
  }

  close() {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new KitRpcError(-32000, 'the connection is closed'))
    this.pending.clear()
    this.port.close()
  }

  private post(message: Message, transfer = false) {
    this.port.postMessage(message, transfer ? transferables(message.params ?? message.result) : [])
  }

  private async receive(message: Message) {
    if (!message || message.jsonrpc !== '2.0') return
    if (message.method && message.id !== undefined) {
      const handler = this.handlers.get(message.method)
      if (!handler) return this.post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported` } })
      try {
        const result = await handler(message.params as never)
        // Answers are copied: the answering side may still hold what it answered (a cached file).
        // `null` is an answer (`host/replicaRead` with nothing stored); only no value becomes `{}`.
        this.post({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result })
      } catch (error) {
        const failure = error instanceof KitRpcError ? error : new KitRpcError(-32000, error instanceof Error ? error.message : String(error))
        this.post({ jsonrpc: '2.0', id: message.id, error: { code: failure.code, message: failure.message, data: failure.data } })
      }
      return
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params as never)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new KitRpcError(message.error.code, message.error.message, message.error.data))
    else pending.resolve(message.result)
  }
}

/** The host's end: sends host-to-kit requests, answers the kit's. */
export type HostPeer = KitPeer<HostToKit, KitToHost, HostNotifications, KitNotifications>
/** The kit's end. */
export type KitSidePeer = KitPeer<KitToHost, HostToKit, KitNotifications, HostNotifications>

/** `Cmd+N` and the like, against a key event: `Cmd` is Meta on macOS and Control elsewhere. */
export function matchesShortcut(shortcut: string, event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean) {
  const parts = shortcut.split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  const command = mac ? event.metaKey : event.ctrlKey
  return command === mods.has('Cmd') && event.shiftKey === mods.has('Shift') && event.altKey === mods.has('Alt') && event.key.toLowerCase() === key.toLowerCase()
}
