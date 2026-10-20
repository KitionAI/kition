// Copied from kition-sdk packages/sdk/src/agentRelay.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The server's end of an agent relay to an editor open in a person's page (`@kition/embed`
 * `editor.agentPort`, `KitEmbed 1.3`). The integrator's agent sends MCP messages (`request`); the
 * page takes them (`next`, for example over HTTP long polling or a WebSocket) into its editor's
 * agent port (`relayAgentPort`) and sends the replies back (`reply`). The relay renumbers requests,
 * so several agents can share one page without their ids colliding.
 *
 * Transport-neutral and dependency-free: it runs in Node and in any server runtime.
 */

/** One JSON-RPC 2.0 message (MCP). */
export type RelayMessage = {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type AgentRelay = {
  /**
   * The agent's side: sends one message to the page's editor and answers its reply (`null` for a
   * notification). Rejects when no page takes it within `timeoutMs` (default 60 s) or the relay closes.
   */
  request: (message: RelayMessage, options?: { timeoutMs?: number }) => Promise<RelayMessage | null>
  /**
   * The page's side: the next message for the editor, or `null` when none came within `waitMs`
   * (default 25 s). Abort `signal` when the page's connection closes (a long poll whose page went
   * away): the relay then stops waiting on it, and keeps a message that arrives meanwhile for the next.
   */
  next: (options?: { waitMs?: number; signal?: AbortSignal }) => Promise<RelayMessage | null>
  /** The page's side: the editor's reply to a message `next` gave. */
  reply: (message: RelayMessage) => void
  /** Whether a page asked for messages within the last `staleMs` (default 30 s). */
  connected: (staleMs?: number) => boolean
  /** Refuses waiting and later requests. */
  close: () => void
}

/** A relay between an agent and one editor in a page (see the module comment). */
export function createAgentRelay(): AgentRelay {
  const queue: RelayMessage[] = []
  const takers: Array<(message: RelayMessage | null) => void> = []
  const waiting = new Map<number, { id: RelayMessage['id']; resolve: (reply: RelayMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let counter = 0
  let lastSeen = -Infinity
  let closed = false

  const deliver = (message: RelayMessage) => {
    const taker = takers.shift()
    if (taker) taker(message)
    else queue.push(message)
  }

  return {
    request: (message, options) => {
      if (closed) return Promise.reject(new Error('the agent relay is closed'))
      if (message.id === undefined || message.id === null) {
        deliver(message)
        return Promise.resolve(null)
      }
      counter += 1
      const relayed = counter
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(relayed)
          const index = queue.findIndex((queued) => queued.id === relayed)
          if (index >= 0) queue.splice(index, 1)
          reject(new Error(`no page answered ${message.method ?? 'the request'} in time: is the document open in the page?`))
        }, options?.timeoutMs ?? 60_000)
        waiting.set(relayed, { id: message.id, resolve, reject, timer })
        deliver({ ...message, id: relayed })
      })
    },
    next: (options) => {
      lastSeen = Date.now()
      const signal = options?.signal
      if (closed || signal?.aborted) return Promise.resolve(null)
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((resolve) => {
        const stop = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', gone)
          const index = takers.indexOf(take)
          if (index >= 0) takers.splice(index, 1)
        }
        const take = (message: RelayMessage | null) => {
          stop()
          // A page that went away as the message came: the next page takes it.
          if (message && signal?.aborted) {
            queue.unshift(message)
            resolve(null)
          } else resolve(message)
        }
        const gone = () => {
          stop()
          resolve(null)
        }
        const timer = setTimeout(() => {
          stop()
          lastSeen = Date.now()
          resolve(null)
        }, options?.waitMs ?? 25_000)
        signal?.addEventListener('abort', gone, { once: true })
        takers.push(take)
      })
    },
    reply: (message) => {
      const relayed = typeof message.id === 'number' ? waiting.get(message.id) : undefined
      if (!relayed) return
      waiting.delete(message.id as number)
      clearTimeout(relayed.timer)
      relayed.resolve({ ...message, id: relayed.id })
    },
    connected: (staleMs = 30_000) => takers.length > 0 || Date.now() - lastSeen < staleMs,
    close: () => {
      closed = true
      for (const take of takers.splice(0)) take(null)
      for (const { reject, timer } of waiting.values()) {
        clearTimeout(timer)
        reject(new Error('the agent relay is closed'))
      }
      waiting.clear()
      queue.length = 0
    },
  }
}
