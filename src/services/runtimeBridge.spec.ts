import { describe, expect, it, vi } from 'vitest'
import { createRuntimeBridge, createTableChangedChannel, createTableReplicaChangedChannel, type BridgeChannel, type BridgeConnection, type BridgeTransport } from './runtimeBridge'

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
  function wellFormedEvent(overrides: Record<string, unknown> = {}) {
    return {
      documentId: '1',
      origin: 'agent:t1',
      tables: [],
      schema: [],
      views: [],
      recordsUpserted: [],
      recordsDeleted: [],
      recordsReordered: [],
      dashboards: false,
      documentPath: 'a.kitable',
      ...overrides,
    }
  }

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
    const ready = () => state.channel?.ready?.()
    return { transport, state, emit, ready }
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

  it('delivers a well-formed table/changed to every subscriber', () => {
    const { transport, emit } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const first = vi.fn()
    const second = vi.fn()
    channel.subscribe(first)
    channel.subscribe(second)
    const params = wellFormedEvent()
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
    emit(wellFormedEvent())
    expect(listener).not.toHaveBeenCalled()
  })

  it('drops a malformed event with a console warning instead of dispatching it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { transport, emit } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const listener = vi.fn()
    channel.subscribe(listener)

    emit({ documentId: '1' }) // missing origin, the TableChange arrays, dashboards, documentPath
    emit(null as unknown as Record<string, unknown>)
    emit({ ...wellFormedEvent(), dashboards: 'not-a-boolean' })

    expect(listener).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('does not resync on the first bridge.ready, only on a later one', () => {
    const { transport, ready } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const resync = vi.fn()
    channel.subscribe(() => undefined)
    channel.onResync(resync)

    ready() // the initial connection's announcement — nothing could have been missed yet
    expect(resync).not.toHaveBeenCalled()

    ready() // a reconnect — events may have been lost while the stream was down
    expect(resync).toHaveBeenCalledTimes(1)
    ready()
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('treats the next subscription after a full unsubscribe as a fresh first connection', () => {
    const { transport, ready } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const resync = vi.fn()
    channel.onResync(resync)

    const unsubscribe = channel.subscribe(() => undefined)
    ready()
    unsubscribe()

    channel.subscribe(() => undefined)
    ready()
    expect(resync).not.toHaveBeenCalled()
    ready()
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('stops notifying an unsubscribed resync listener', () => {
    const { transport, ready } = fakeTransport()
    const channel = createTableChangedChannel(transport)
    const resync = vi.fn()
    channel.subscribe(() => undefined)
    const unsubscribeResync = channel.onResync(resync)

    ready()
    unsubscribeResync()
    ready()
    expect(resync).not.toHaveBeenCalled()
  })
})

describe('table/replica-changed channel', () => {
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
    return { transport, state }
  }

  it('handles only table/replica-changed, and opens the stream while subscribed', () => {
    const { transport, state } = fakeTransport()
    const subscribe = createTableReplicaChangedChannel(transport)
    const unsubscribe = subscribe(() => undefined)
    expect(state.opens).toBe(1)
    expect(state.channel?.handles('table/replica-changed')).toBe(true)
    expect(state.channel?.handles('table/changed')).toBe(false)
    unsubscribe()
    expect(state.closes).toBe(1)
  })

  it('delivers well-formed events and drops malformed ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { transport, state } = fakeTransport()
    const listener = vi.fn()
    createTableReplicaChangedChannel(transport)(listener)
    const params = { documentPath: 'a.kitable', docId: 'd', version: 'AQ==' }
    state.channel?.handle('table/replica-changed', params)
    state.channel?.handle('table/replica-changed', { documentPath: 'a.kitable' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(params)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
