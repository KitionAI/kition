// Copied from kition-sdk packages/extensions/src/rpc.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The channel between the host and an extension's worker: requests, answers, and notifications
 * as plain objects over one `MessagePort` (or anything with its `postMessage` and `onmessage`).
 */

/** What a `MessagePort` offers that the channel uses; fakes in tests offer the same. */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  // Bivariant, so a `MessagePort` (whose listener takes a `MessageEvent`) is one.
  onmessage: { bivarianceHack(event: { data: unknown; ports?: readonly MessagePort[] }): void }['bivarianceHack'] | null
  start?(): void
  close?(): void
}

/** Every message on the channel carries this tag; anything else is ignored. */
export const CHANNEL_TAG = 'kition-ext/1'

/**
 * An error that crosses the channel. `code` is `permission-denied`, `not-found`, `invalid`,
 * `failed`, or one of the object model's batch codes (`read-only`, `invalid-op`, …).
 */
export class ExtensionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = code === 'permission-denied' ? 'PermissionError' : 'ExtensionError'
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.data ? { data: this.data } : {}) }
  }
}

type Message = { tag: typeof CHANNEL_TAG; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: string; message: string; data?: Record<string, unknown> } }

/** Answers a request or a notification; `ports` are the `MessagePort`s that came with it. */
export type Handler = (params: never, ports: readonly MessagePort[]) => unknown

const isMessage = (value: unknown): value is Message => typeof value === 'object' && value !== null && (value as Message).tag === CHANNEL_TAG

/** An error as it crosses the channel; batch errors keep their code and the failing op's index. */
function wireError(error: unknown): Message['error'] {
  if (error instanceof ExtensionError) return error.toJSON()
  const coded = error as Error & { code?: unknown; index?: unknown }
  if (error instanceof Error && typeof coded.code === 'string') {
    return { code: coded.code, message: error.message, ...(coded.index !== undefined ? { data: { index: coded.index } } : {}) }
  }
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** One end of the channel. */
export class RpcPeer {
  private next = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  private handlers = new Map<string, Handler>()
  private closed = false

  constructor(private readonly port: PortLike) {
    port.onmessage = (event) => this.receive(event.data, event.ports ?? [])
    port.start?.()
  }

  /** Answers `method` with `handler` (its result, or the error it throws). */
  handle(method: string, handler: Handler) {
    this.handlers.set(method, handler)
    return this
  }

  /** Asks `method`; `transfer` (a `MessagePort`, …) goes with the request. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0, transfer?: Transferable[]): Promise<T> {
    if (this.closed) return Promise.reject(new ExtensionError('failed', 'the extension channel is closed'))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new ExtensionError('failed', `${method} did not answer within ${timeoutMs} ms`))
        }, timeoutMs)
      }
      const message = { tag: CHANNEL_TAG, id, method, params } satisfies Message
      if (transfer?.length) this.port.postMessage(message, transfer)
      else this.port.postMessage(message)
    })
  }

  notify(method: string, params?: unknown) {
    if (!this.closed) this.port.postMessage({ tag: CHANNEL_TAG, method, params } satisfies Message)
  }

  /** Fails every request still waiting and stops listening. */
  close(reason = 'the extension channel is closed') {
    if (this.closed) return
    this.closed = true
    this.port.onmessage = null
    this.port.close?.()
    for (const { reject } of this.pending.values()) reject(new ExtensionError('failed', reason))
    this.pending.clear()
  }

  private receive(data: unknown, ports: readonly MessagePort[]) {
    if (!isMessage(data) || this.closed) return
    if (data.method !== undefined) {
      void this.answer(data, ports)
      return
    }
    if (data.id === undefined) return
    const waiting = this.pending.get(data.id)
    if (!waiting) return
    this.pending.delete(data.id)
    if (data.error) waiting.reject(new ExtensionError(data.error.code, data.error.message, data.error.data))
    else waiting.resolve(data.result)
  }

  private async answer(message: Message, ports: readonly MessagePort[]) {
    const handler = this.handlers.get(message.method!)
    let reply: Message
    try {
      if (!handler) throw new ExtensionError('not-found', `${message.method} is not served here`)
      const result = await handler(message.params as never, ports)
      reply = { tag: CHANNEL_TAG, id: message.id, result: result === undefined ? null : result }
    } catch (error) {
      reply = { tag: CHANNEL_TAG, id: message.id, error: wireError(error) }
    }
    if (message.id === undefined || this.closed) return
    try {
      this.port.postMessage(reply)
    } catch (error) {
      // An answer that cannot be cloned (a function, a DOM object) fails the request instead.
      this.port.postMessage({ tag: CHANNEL_TAG, id: message.id, error: { code: 'failed', message: `${message.method} answered a value that cannot be sent: ${error instanceof Error ? error.message : String(error)}` } } satisfies Message)
    }
  }
}
