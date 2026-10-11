import { afterEach, describe, expect, it, vi } from 'vitest'
import { KitEngine, type KitEngineRequest } from './kitEngine'
import { kitSdkCommands, type KitSdkManifest } from './kitSdk'

const manifest: KitSdkManifest = { kitId: 'kit.test', dir: 'test-sdk', module: 'kition_test_sdk', documentClass: 'TestDocument' }
const info = { width: 4, height: 2, revision: 1, dirty: false, canUndo: false, canRedo: false, inspected: {} }

/** A worker that answers each request with `reply`, asynchronously. */
class FakeWorker {
  static last: FakeWorker | null = null
  /** The reply of the next worker's first request. */
  static openReply: { ok: true; value: unknown } | { ok: false; error: string } = { ok: true, value: info }
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  requests: KitEngineRequest[] = []
  terminated = false
  reply: (request: KitEngineRequest) => { ok: true; value: unknown } | { ok: false; error: string } = () => ({ ok: true, value: info })
  silent = false

  constructor() {
    FakeWorker.last = this
    const first = FakeWorker.openReply
    const later = this.reply
    let opened = false
    this.reply = (request) => {
      if (opened) return later(request)
      opened = true
      return first
    }
  }

  postMessage({ id, request }: { id: number; request: KitEngineRequest }) {
    this.requests.push(request)
    if (this.silent) return
    const answer = this.reply(request)
    queueMicrotask(() => this.onmessage?.({ data: { id, ...answer } } as MessageEvent))
  }

  terminate() {
    this.terminated = true
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.openReply = { ok: true, value: info }
})

describe('KitEngine', () => {
  it('opens the file in a worker and keeps info current after changes', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const engine = await KitEngine.open(manifest, 'a.test', new ArrayBuffer(3))
    const worker = FakeWorker.last!
    expect(worker.requests[0]).toMatchObject({ method: 'open', manifest, name: 'a.test' })
    expect(engine.width).toBe(4)

    worker.reply = (request) => request.method === 'execute'
      ? { ok: true, value: { result: '{"changed":true}', info: { ...info, revision: 2, dirty: true, canUndo: true } } }
      : { ok: false, error: 'unknown command' }
    await expect(engine.execute('paint.stroke', { size: 3 })).resolves.toBe('{"changed":true}')
    expect(engine.info).toMatchObject({ revision: 2, dirty: true, canUndo: true })
    await expect(engine.commands()).rejects.toThrow('unknown command')
  })

  it('rejects waiting calls when the worker fails or the document closes', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const engine = await KitEngine.open(manifest, 'a.test', new ArrayBuffer(3))
    const worker = FakeWorker.last!
    worker.silent = true
    const waiting = engine.render(0, 0, 1, 4, 2)
    worker.onerror?.({ message: 'out of memory' } as ErrorEvent)
    await expect(waiting).rejects.toThrow('out of memory')
    await expect(engine.save()).rejects.toThrow('out of memory')
    engine.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('stops the worker when the file does not open', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    FakeWorker.openReply = { ok: false, error: 'not a test file' }
    await expect(KitEngine.open(manifest, 'broken.test', new ArrayBuffer(1))).rejects.toThrow('not a test file')
    expect(FakeWorker.last!.terminated).toBe(true)
  })
})

describe('kitSdkCommands', () => {
  it('shapes SDK commands like the runtime command list', () => {
    const commands = kitSdkCommands(JSON.stringify([{ id: 'layer.new.layer', title: 'New Layer', menu: ['Layer', 'New'], shortcut: 'Cmd+Shift+N', mutates: true, enabled: true, params: '{name?: string}' }, { id: 'view.fit', title: 'Fit', menu: null, shortcut: null, mutates: false, enabled: false }]))
    expect(commands[0]).toEqual({ id: 'layer.new.layer', title: 'New Layer', description: null, group: 'layer', mutates: true, enabled: true, menu: ['Layer', 'New'], shortcut: 'Cmd+Shift+N', schema: null, params: '{name?: string}' })
    expect(commands[1].params).toBeNull()
    expect(commands[1].menu).toEqual([])
  })
})
