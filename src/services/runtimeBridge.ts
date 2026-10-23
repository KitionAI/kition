import { kitBridgeURL, postKitBridgeMessage } from '@/api/kits'

/**
 * This window's one stream from the runtime, `GET /v1/kits/bridge`: the
 * runtime sends JSON-RPC requests as server-sent events, and the window
 * answers each with `POST /v1/kits/bridge?session=<id>`. Several channels
 * share the stream (the Kit AI bridge's `kit/*` and the document bridge's
 * `document/*`), so a window holds one connection however many editors it
 * has open. The stream is open while any channel is.
 */

/** One kind of request this window answers, such as the kit editors' `kit/*`. */
export type BridgeChannel = {
  /** Whether this channel answers `method`. */
  handles: (method: string) => boolean
  /** The answer to a request; a thrown error is sent as a JSON-RPC error. */
  handle: (method: string, params: Record<string, unknown>) => unknown
  /** A new stream is ready: announce this window's state to the runtime again. */
  ready?: () => void
}

export type BridgeTransport = {
  /** Starts answering the runtime's requests for `channel`; returns the function that stops. */
  open: (channel: BridgeChannel) => () => void
  /** Sends a notification to the runtime on the current stream; dropped while no stream is ready. */
  notify: (method: string, params: Record<string, unknown>) => void
}

/** How the transport reaches the runtime: the event stream and the answer endpoint. */
export type BridgeConnection = {
  connect: (onMessage: (data: string) => void) => { close: () => void } | null
  post: (session: number, message: Record<string, unknown>) => Promise<unknown>
}

type Message = { jsonrpc?: '2.0'; id?: number; method?: string; params?: Record<string, unknown> }

export function createRuntimeBridge(connection: BridgeConnection): BridgeTransport {
  const channels = new Set<BridgeChannel>()
  // Each channel answers its requests one after another, in the order the runtime sent them
  // (a kit run, then its preview); a slow kit call does not hold up a document edit.
  const queues = new Map<BridgeChannel | null, Promise<unknown>>()
  let stream: { close: () => void } | null = null
  let session: number | null = null

  function send(to: number | null, message: Record<string, unknown>) {
    if (to == null) return
    void connection.post(to, { jsonrpc: '2.0', ...message }).catch(() => undefined)
  }

  function receive(data: string) {
    let message: Message
    try {
      message = JSON.parse(data) as Message
    } catch {
      return
    }
    const method = String(message.method ?? '')
    const params = message.params ?? {}
    if (method === 'bridge.ready') {
      session = Number(params.session)
      for (const channel of channels) channel.ready?.()
      return
    }
    const channel = [...channels].find((candidate) => candidate.handles(method)) ?? null
    // An answer goes to the session its request came on, even if the stream has reconnected since.
    let replyTo: number | null = null
    const queued = (queues.get(channel) ?? Promise.resolve())
      .then(() => {
        replyTo = session
        if (!channel) throw new Error(`unknown bridge method ${method}`)
        return channel.handle(method, params)
      })
      .then(
        (result) => {
          if (message.id != null) send(replyTo, { id: message.id, result: result ?? {} })
        },
        (error: unknown) => {
          if (message.id == null) return
          // A refusal's `data` (an object-model `{ code, index, message }`, a `{ reason }`) goes along.
          const data = (error as { data?: unknown } | null)?.data
          const failure = { code: -32000, message: error instanceof Error ? error.message : String(error), ...(data && typeof data === 'object' ? { data } : {}) }
          send(replyTo, { id: message.id, error: failure })
        },
      )
    queues.set(channel, queued)
  }

  return {
    open(channel) {
      channels.add(channel)
      // The browser reconnects on its own; the new stream announces its session first.
      if (!stream) stream = connection.connect(receive)
      return () => {
        if (!channels.delete(channel)) return
        queues.delete(channel)
        if (channels.size) return
        stream?.close()
        stream = null
        session = null
        queues.clear()
      }
    },
    notify(method, params) {
      send(session, { method, params })
    },
  }
}

const browserConnection: BridgeConnection = {
  connect(onMessage) {
    if (typeof EventSource === 'undefined') return null
    const source = new EventSource(kitBridgeURL())
    source.onmessage = (event: MessageEvent<string>) => onMessage(event.data)
    return source
  },
  post: postKitBridgeMessage,
}

/** This window's bridge stream. */
export const runtimeBridge = createRuntimeBridge(browserConnection)
