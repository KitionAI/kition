import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posted = vi.hoisted(() => [] as Array<{ session: number; message: Record<string, unknown> }>)
vi.mock('@/api/kits', () => ({
  kitBridgeURL: () => 'http://127.0.0.1/v1/kits/bridge',
  postKitBridgeMessage: async (session: number, message: Record<string, unknown>) => {
    posted.push({ session, message })
  },
}))

class FakeEventSource {
  static streams: FakeEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.streams.push(this)
  }
  close() {
    this.closed = true
  }
  emit(message: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', ...message }) }))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('kitBridge on the shared bridge stream', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.streams = []
    posted.length = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  it('answers kit requests and shares the stream with other channels', async () => {
    const { registerBridgeEditor, reportBridgeChange } = await import('./kitBridge')
    const { runtimeBridge } = await import('@/services/runtimeBridge')
    const withdraw = registerBridgeEditor({
      path: './art/a.kitionvector',
      kitId: 'kit.vector',
      revision: () => 3,
      dirty: () => false,
      inspect: () => ({ path: 'art/a.kitionvector', summary: '', dirty: false, canUndo: false, canRedo: false, details: {} }),
      commands: async () => [],
      run: async () => ({ completed: [], saved: false }),
      preview: async () => '',
    })
    // Another channel on the same stream, as the document bridge opens it.
    const close = runtimeBridge.open({ handles: (method) => method.startsWith('document/'), handle: () => ({ open: true, content: 'text' }), ready: () => runtimeBridge.notify('documents.open', { paths: ['Notes/a.md'] }) })
    expect(FakeEventSource.streams).toHaveLength(1)
    const [stream] = FakeEventSource.streams
    stream.emit({ method: 'bridge.ready', params: { session: 7 } })
    stream.emit({ id: 1, method: 'kit/documents', params: {} })
    stream.emit({ id: 2, method: 'document/read', params: { path: 'Notes/a.md' } })
    stream.emit({ id: 3, method: 'kit/call', params: { path: 'other.kitionvector', kit: 'kit.vector', tool: 'inspect', arguments: {} } })
    reportBridgeChange({ path: '/art/a.kitionvector', revision: 4, by: 'agent' })
    await settle()
    const byId = (id: number) => posted.find((entry) => entry.message.id === id)?.message
    expect(byId(1)?.result).toEqual({ documents: [{ path: './art/a.kitionvector', kit: 'kit.vector', dirty: false, revision: 3 }] })
    expect(byId(2)?.result).toEqual({ open: true, content: 'text' })
    expect(byId(3)?.error).toMatchObject({ message: expect.stringContaining('not open in a kit editor') })
    expect(posted.map((entry) => entry.message.method).filter(Boolean)).toEqual(['documents.open', 'kit.changed'])
    expect(posted.every((entry) => entry.session === 7)).toBe(true)

    withdraw()
    expect(stream.closed).toBe(false)
    close()
    expect(stream.closed).toBe(true)
  })
})
