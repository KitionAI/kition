import { describe, expect, it, vi } from 'vitest'
import { createRuntimeBridge, createTableChangedChannel, type BridgeChannel, type BridgeConnection, type BridgeTransport } from './runtimeBridge'

function fakeConnection() {
  const posted: Array<{ session: number; message: Record<string, unknown> }> = []
  const state = { send: null as ((data: string) => void) | null, connects: 0, closes: 0 }
  const connection: BridgeConnection = {
    connect(onMessage) {
      state.connects += 1
      state.send = onMessage
      return { close: () => (state.closes += 1) }
    },
    post: async (session, message) => {
      posted.push({ session, message })
    },
  }
  const send = (message: Record<string, unknown>) => state.send?.(JSON.stringify({ jsonrpc: '2.0', ...message }))
  return { connection, posted, state, send }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runtimeBridge', () => {
  it('opens one stream for all channels and closes it with the last one', () => {
    const { connection, state } = fakeConnection()
    const bridge = createRuntimeBridge(connection)
    const closeA = bridge.open({ handles: () => false, handle: () => null })
    const closeB = bridge.open({ handles: () => false, handle: () => null })
    expect(state.connects).toBe(1)
    closeA()
    closeA()
    expect(state.closes).toBe(0)
    closeB()
    expect(state.closes).toBe(1)
  })

  it('routes requests to the channel that handles them and answers on the session they came on', async () => {
    const { connection, posted, send } = fakeConnection()
    const bridge = createRuntimeBridge(connection)
    const ready = vi.fn()
    bridge.open({ handles: (method) => method.startsWith('kit/'), handle: (method) => ({ kit: method }) })
    bridge.open({ handles: (method) => method.startsWith('document/'), handle: (_method, params) => ({ doc: params.path }), ready })
    send({ method: 'bridge.ready', params: { session: 4 } })
    expect(ready).toHaveBeenCalledTimes(1)
    send({ id: 1, method: 'kit/documents', params: {} })
    send({ id: 2, method: 'document/read', params: { path: 'a.md' } })
    send({ id: 3, method: 'other/thing', params: {} })
    send({ id: 4, method: 'document/apply', params: { path: 'b.md' } })
    await settle()
    expect(posted.sort((a, b) => Number(a.message.id) - Number(b.message.id))).toEqual([
      { session: 4, message: { jsonrpc: '2.0', id: 1, result: { kit: 'kit/documents' } } },
      { session: 4, message: { jsonrpc: '2.0', id: 2, result: { doc: 'a.md' } } },
      { session: 4, message: { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'unknown bridge method other/thing' } } },
      { session: 4, message: { jsonrpc: '2.0', id: 4, result: { doc: 'b.md' } } },
    ])
  })

  it('answers a request on the session it came on, even after a reconnect', async () => {
    const { connection, posted, send } = fakeConnection()
    const bridge = createRuntimeBridge(connection)
    let release: () => void = () => undefined
    const slow = new Promise<void>((resolve) => (release = resolve))
    bridge.open({ handles: () => true, handle: () => slow.then(() => 'done') })
    send({ method: 'bridge.ready', params: { session: 1 } })
    send({ id: 1, method: 'kit/call', params: {} })
    await settle()
    send({ method: 'bridge.ready', params: { session: 2 } })
    release()
    await settle()
    expect(posted).toEqual([{ session: 1, message: { jsonrpc: '2.0', id: 1, result: 'done' } }])
  })

  it('answers each channel in order without waiting for another channel', async () => {
    const { connection, posted, send } = fakeConnection()
    const bridge = createRuntimeBridge(connection)
    let release: () => void = () => undefined
    const slow = new Promise<void>((resolve) => (release = resolve))
    const kit: BridgeChannel = { handles: (method) => method.startsWith('kit/'), handle: async (method) => (method === 'kit/call' ? slow.then(() => 'ran') : 'previewed') }
    bridge.open(kit)
    bridge.open({ handles: (method) => method.startsWith('document/'), handle: () => 'read' })
    send({ method: 'bridge.ready', params: { session: 1 } })
    send({ id: 1, method: 'kit/call', params: {} })
    send({ id: 2, method: 'kit/preview', params: {} })
    send({ id: 3, method: 'document/read', params: {} })
    await settle()
    expect(posted.map((entry) => entry.message.id)).toEqual([3])
    release()
    await settle()
    expect(posted.map((entry) => [entry.message.id, entry.message.result])).toEqual([
      [3, 'read'],
      [1, 'ran'],
      [2, 'previewed'],
    ])
  })

  it('sends notifications only on a ready stream and reports failures as errors', async () => {
    const { connection, posted, send } = fakeConnection()
    const bridge = createRuntimeBridge(connection)
    bridge.notify('documents.open', { paths: [] })
    bridge.open({
      handles: () => true,
      handle: () => {
        throw new Error('refused')
      },
    })
    send({ method: 'bridge.ready', params: { session: 9 } })
    bridge.notify('documents.open', { paths: ['a.md'] })
    send({ id: 1, method: 'kit/call', params: {} })
    send({ method: 'kit/ignored-notification', params: {} })
    await settle()
    expect(posted).toEqual([
      { session: 9, message: { jsonrpc: '2.0', method: 'documents.open', params: { paths: ['a.md'] } } },
      { session: 9, message: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'refused' } } },
    ])
  })
})

describe('createTableChangedChannel', () => {
  function fakeTransport() {
    const state = { channel: null as BridgeChannel | null, opens: 0, closes: 0 }
    const transport: BridgeTransport = {
      open(channel) {
        state.opens += 1
        state.channel = channel
        return () => {
          state.closes += 1
          state.channel = null
        }
      },
      notify: () => undefined,
    }
    const emit = (params: Record<string, unknown>) => state.channel?.handle('table/changed', params)
    return { transport, state, emit }
  }

  it('opens the stream only while at least one listener is subscribed', () => {
    const { transport, state } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const unsubscribeA = channel.subscribe(() => undefined)
    const unsubscribeB = channel.subscribe(() => undefined)
    expect(state.opens).toBe(1)
    unsubscribeA()
    unsubscribeA()
    expect(state.closes).toBe(0)
    unsubscribeB()
    expect(state.closes).toBe(1)
  })

  it('delivers table/changed to every subscriber', () => {
    const { transport, emit } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const first = vi.fn()
    const second = vi.fn()
    channel.subscribe(first)
    channel.subscribe(second)
    const params = { documentId: '1', origin: 'agent:t1', documentPath: 'a.kitable' }
    emit(params)
    expect(first).toHaveBeenCalledWith(params)
    expect(second).toHaveBeenCalledWith(params)
  })

  it('stops delivering to an unsubscribed listener', () => {
    const { transport, emit } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const listener = vi.fn()
    const unsubscribe = channel.subscribe(listener)
    unsubscribe()
    emit({ documentId: '1' })
    expect(listener).not.toHaveBeenCalled()
  })
})
