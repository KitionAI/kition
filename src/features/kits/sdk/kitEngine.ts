import type { KitCommand, KitSdkManifest } from './kitSdk'
import type { LentFiles } from './lentFiles'

/** What the page keeps in sync about the open document after every request that can change it. */
export type KitEngineInfo = {
  width: number
  height: number
  revision: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  /** The SDK's `inspect()` JSON; each kit's editor reads its own fields from it. */
  inspected: Record<string, unknown>
}

export type KitEngineRequest =
  | { method: 'open'; manifest: KitSdkManifest; name: string; bytes: ArrayBuffer; lent: LentFiles | null }
  | { method: 'create'; manifest: KitSdkManifest; name: string; width: number; height: number }
  | { method: 'execute'; command: string; params: Record<string, unknown> }
  | { method: 'render'; x: number; y: number; scale: number; width: number; height: number }
  | { method: 'renderArea'; x0: number; y0: number; x1: number; y1: number; width: number; height: number }
  | { method: 'commands' }
  | { method: 'save' }
  | { method: 'markSaved' }
  | { method: 'invoke'; name: string; args: unknown[] }

export type KitEngineResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const CLOSED_INFO: KitEngineInfo = { width: 0, height: 0, revision: 0, dirty: false, canUndo: false, canRedo: false, inspected: {} }

/**
 * The page's handle on one document open in a kit engine worker. Every call
 * is asynchronous and answered in order; `info` is current after each change.
 */
export class KitEngine {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failure: Error | null = null

  private constructor(private readonly worker: Worker, public info: KitEngineInfo) {}

  /**
   * Starts a worker and opens the file's bytes in it with the kit's SDK; the bytes move to the
   * worker. `lent` is where the document's other files (media) are read from, if anywhere.
   */
  static async open(manifest: KitSdkManifest, name: string, bytes: ArrayBuffer, lent: LentFiles | null = null) {
    const worker = new Worker(new URL('./kitEngine.worker.ts', import.meta.url), { type: 'module' })
    const engine = new KitEngine(worker, CLOSED_INFO)
    worker.onmessage = (event: MessageEvent<KitEngineResponse>) => engine.settle(event.data)
    worker.onerror = (event) => engine.fail(new Error(event.message || 'the kit engine stopped'))
    try {
      engine.info = (await engine.call({ method: 'open', manifest, name, bytes, lent }, [bytes])) as KitEngineInfo
      return engine
    } catch (error) {
      engine.dispose()
      throw error
    }
  }

  /** Starts a worker with a new, empty document made by the kit's SDK; nothing is written yet. */
  static async create(manifest: KitSdkManifest, name: string, width: number, height: number) {
    const worker = new Worker(new URL('./kitEngine.worker.ts', import.meta.url), { type: 'module' })
    const engine = new KitEngine(worker, CLOSED_INFO)
    worker.onmessage = (event: MessageEvent<KitEngineResponse>) => engine.settle(event.data)
    worker.onerror = (event) => engine.fail(new Error(event.message || 'the kit engine stopped'))
    try {
      engine.info = (await engine.call({ method: 'create', manifest, name, width, height })) as KitEngineInfo
      return engine
    } catch (error) {
      engine.dispose()
      throw error
    }
  }

  get width() {
    return this.info.width
  }

  get height() {
    return this.info.height
  }

  private settle(response: KitEngineResponse) {
    const waiting = this.pending.get(response.id)
    if (!waiting) return
    this.pending.delete(response.id)
    if (response.ok === true) waiting.resolve(response.value)
    else waiting.reject(new Error(response.error))
  }

  private fail(error: Error) {
    this.failure = error
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }

  private call(request: KitEngineRequest, transfer: Transferable[] = []) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, request }, transfer)
    })
  }

  async execute(command: string, params: Record<string, unknown> = {}) {
    const { result, info } = (await this.call({ method: 'execute', command, params })) as { result: string; info: KitEngineInfo }
    this.info = info
    return result
  }

  /** RGBA8 of the area at (`x`, `y`) document pixels shown at `scale` screen pixels per pixel. */
  async render(x: number, y: number, scale: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'render', x, y, scale, width, height })) as ArrayBuffer)
  }

  /** RGBA8 of the document area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  async renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'renderArea', x0, y0, x1, y1, width, height })) as ArrayBuffer)
  }

  async commands() {
    return (await this.call({ method: 'commands' })) as KitCommand[]
  }

  /** The document as file bytes; it stays unsaved until `markSaved`. */
  async save() {
    return new Uint8Array((await this.call({ method: 'save' })) as ArrayBuffer)
  }

  async markSaved() {
    this.info = (await this.call({ method: 'markSaved' })) as KitEngineInfo
  }

  /**
   * Calls one of the kit SDK's own document methods beyond the shared contract, for example
   * Photo's `selectionOutline`. Typed-array results arrive as that array. Changes made this way
   * are not reflected in `info`; use `execute` for edits.
   */
  async invoke<T = unknown>(name: string, ...args: unknown[]) {
    return (await this.call({ method: 'invoke', name, args })) as T
  }

  dispose() {
    this.worker.terminate()
    this.fail(new Error('the document was closed'))
  }
}
