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

  it("runs the agent's draft calls on the editor's draft, and offers no merge or discard", async () => {
    const { registerBridgeEditor } = await import('./kitBridge')
    const calls: unknown[] = []
    const live = { path: 'talks/a.pptx', summary: '1 slide', dirty: false, canUndo: false, canRedo: false, details: {} }
    const withdraw = registerBridgeEditor({
      path: 'talks/a.pptx',
      kitId: 'kit.slide',
      revision: () => 1,
      dirty: () => false,
      inspect: (options) => ({ ...live, summary: options?.draft ? '2 slides, draft' : live.summary }),
      commands: async () => [],
      run: async (steps, save, options) => {
        calls.push(['run', steps.length, save, options])
        return { completed: [{ command: 'slide.add', changed: true, result: null }], saved: false }
      },
      preview: async (maxSize, options) => (options?.draft ? `draft ${maxSize}` : `live ${maxSize}`),
      draft: {
        ready: async () => ({ state: 'ready', revision: 2 }),
        reopen: async () => ({ state: 'open', revision: 2 }),
      },
      check: async (options) => [{ code: options?.draft ? 'slide.on-draft' : 'slide.on-document', severity: 'warning', target: { slide: 1 }, message: 'Found.' }],
    })
    const withdrawPlain = registerBridgeEditor({
      path: 'art/b.kitionvector',
      kitId: 'kit.vector',
      revision: () => 1,
      dirty: () => false,
      inspect: () => live,
      commands: async () => [],
      run: async () => ({ completed: [], saved: false }),
      preview: async () => '',
    })
    const stream = FakeEventSource.streams.at(-1)!
    stream.emit({ method: 'bridge.ready', params: { session: 8 } })
    const call = (id: number, tool: string, args: Record<string, unknown> = {}, path = 'talks/a.pptx', kit = 'kit.slide') => stream.emit({ id, method: 'kit/call', params: { path, kit, tool, arguments: args } })
    call(11, 'run', { steps: [{ command: 'slide.add' }], save: true, draft: true })
    call(12, 'draft_ready')
    call(13, 'draft_reopen')
    stream.emit({ id: 14, method: 'kit/preview', params: { path: 'talks/a.pptx', maxSize: 64, draft: true } })
    call(15, 'draft_merge')
    call(16, 'run', { steps: [{ command: 'shape.ellipse' }], draft: true }, 'art/b.kitionvector', 'kit.vector')
    call(17, 'run', { steps: [{ command: 'slide.add' }] })
    call(18, 'check')
    call(19, 'check', { draft: true })
    call(20, 'check', {}, 'art/b.kitionvector', 'kit.vector')
    await settle()
    await settle()
    const byId = (id: number) => posted.find((entry) => entry.message.id === id)?.message
    expect(byId(11)?.result).toMatchObject({ saved: false, document: { summary: '2 slides, draft' } })
    expect(byId(12)?.result).toEqual({ state: 'ready', revision: 2 })
    expect(byId(13)?.result).toEqual({ state: 'open', revision: 2 })
    expect(byId(14)?.result).toEqual({ png: 'draft 64' })
    expect(byId(15)?.error).toMatchObject({ message: expect.stringContaining('unknown kit tool') })
    expect(byId(16)?.error).toMatchObject({ message: expect.stringContaining('keeps no drafts') })
    // Diagnostics of the document or the draft; an editor whose kit cannot check refuses, never answers none.
    expect(byId(18)?.result).toEqual({ diagnostics: [expect.objectContaining({ code: 'slide.on-document' })] })
    expect(byId(19)?.result).toEqual({ diagnostics: [expect.objectContaining({ code: 'slide.on-draft' })] })
    expect(byId(20)?.error).toMatchObject({ message: expect.stringContaining('cannot check documents') })
    // A draft is never saved; a live run saves by default.
    expect(calls).toEqual([
      ['run', 1, false, { draft: true }],
      ['run', 1, true, {}],
    ])
    withdraw()
    withdrawPlain()
  })

  it("runs the agent's object-model calls on the editor's model, notes its edits, and keeps refusal codes", async () => {
    const { registerBridgeEditor } = await import('./kitBridge')
    const { agentEditing } = await import('@/services/agentPresence')
    const batches: unknown[] = []
    const refusal = Object.assign(new Error('op 1 failed'), { data: { code: 'not-found', index: 1, message: 'op 1 failed' } })
    const withdraw = registerBridgeEditor({
      path: 'talks/m.kitionslide',
      kitId: 'kit.slide',
      revision: () => 1,
      dirty: () => false,
      inspect: () => ({ path: 'talks/m.kitionslide', summary: '', dirty: false, canUndo: false, canRedo: false, details: {} }),
      commands: async () => [],
      run: async () => ({ completed: [], saved: false }),
      preview: async () => '',
      model: {
        describe: async () => ({ root: 'Presentation', types: {} }),
        batch: async (request, options) => {
          batches.push([request, options])
          if (request.ops.some((op) => op.target === 'missing')) throw refusal
          return { refs: {}, results: request.ops.map(() => null), loaded: [], version: new ArrayBuffer(2) }
        },
        onDraft: false,
      },
      save: async () => true,
    })
    const withoutModel = registerBridgeEditor({
      path: 'art/n.kitionvector',
      kitId: 'kit.vector',
      revision: () => 1,
      dirty: () => false,
      inspect: () => ({ path: 'art/n.kitionvector', summary: '', dirty: false, canUndo: false, canRedo: false, details: {} }),
      commands: async () => [],
      run: async () => ({ completed: [], saved: false }),
      preview: async () => '',
    })
    const stream = FakeEventSource.streams.at(-1)!
    stream.emit({ method: 'bridge.ready', params: { session: 9 } })
    const call = (id: number, tool: string, args: Record<string, unknown> = {}, path = 'talks/m.kitionslide', kit = 'kit.slide') => stream.emit({ id, method: 'kit/call', params: { path, kit, tool, arguments: args } })
    const set = { op: 'set', target: 'root', field: 'title', value: 'Q3' }
    call(21, 'describe')
    call(22, 'batch', { origin: { kind: 'agent', principal: 'local' }, ops: [], load: [{ target: 'root' }] })
    call(23, 'batch', { ops: [set], load: [], save: true })
    call(24, 'batch', { ops: [set, { op: 'set', target: 'missing', field: 'title', value: 'x' }], load: [] })
    call(25, 'batch', { ops: [set], load: [], draft: true })
    call(26, 'describe', {}, 'art/n.kitionvector', 'kit.vector')
    await settle()
    await settle()
    const byId = (id: number) => posted.find((entry) => entry.message.id === id)?.message
    expect(byId(21)?.result).toEqual({ root: 'Presentation', types: {} })
    // Reading writes nothing and is not an agent edit.
    expect(byId(22)?.result).toEqual({ refs: {}, results: [], loaded: [], saved: false })
    expect(agentEditing('talks/m.kitionslide')).toBe(true)
    expect(byId(23)?.result).toEqual({ refs: {}, results: [null], loaded: [], saved: true })
    expect(byId(24)?.error).toEqual({ code: -32000, message: 'op 1 failed', data: { code: 'not-found', index: 1, message: 'op 1 failed' } })
    // No draft batches on a kit that cannot run them, and none reach the document.
    expect(byId(25)?.error).toMatchObject({ data: { code: 'unsupported' } })
    expect(byId(26)?.error).toMatchObject({ message: expect.stringContaining('no object model'), data: { code: 'unsupported' } })
    expect(batches).toHaveLength(3)
    expect(batches[0]).toEqual([{ origin: { kind: 'agent', principal: 'local' }, ops: [], load: [{ target: 'root' }] }, {}])
    withdraw()
    withoutModel()
  })
})
