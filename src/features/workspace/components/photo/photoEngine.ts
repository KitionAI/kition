import type { KitsCommandView } from '@/api/kits'
import type { PhotoSdkState } from './photoSdk'

/** What the page keeps in sync about the open image after every request that can change it. */
export type PhotoEngineInfo = { width: number; height: number; revision: number; dirty: boolean; state: PhotoSdkState }

export type PhotoEngineRequest =
  | { method: 'open'; name: string; bytes: ArrayBuffer }
  | { method: 'execute'; command: string; params: Record<string, unknown> }
  | { method: 'render'; x: number; y: number; scale: number; width: number; height: number }
  | { method: 'renderArea'; x0: number; y0: number; x1: number; y1: number; width: number; height: number }
  | { method: 'commands' }
  | { method: 'save' }
  | { method: 'markSaved' }

export type PhotoEngineResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/**
 * The page's handle on one image open in a Photo engine worker. Every call is
 * asynchronous and answered in order; `info` is current after each change.
 */
export class PhotoEngine {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failure: Error | null = null

  private constructor(private readonly worker: Worker, public info: PhotoEngineInfo) {}

  /** Starts a worker and opens the file's bytes in it; the bytes move to the worker. */
  static async open(name: string, bytes: ArrayBuffer) {
    const worker = new Worker(new URL('./photoEngine.worker.ts', import.meta.url), { type: 'module' })
    const engine = new PhotoEngine(worker, { width: 0, height: 0, revision: 0, dirty: false, state: null as unknown as PhotoSdkState })
    worker.onmessage = (event: MessageEvent<PhotoEngineResponse>) => engine.settle(event.data)
    worker.onerror = (event) => engine.fail(new Error(event.message || 'the Photo engine stopped'))
    try {
      engine.info = (await engine.call({ method: 'open', name, bytes }, [bytes])) as PhotoEngineInfo
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

  private settle(response: PhotoEngineResponse) {
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

  private call(request: PhotoEngineRequest, transfer: Transferable[] = []) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, request }, transfer)
    })
  }

  async execute(command: string, params: Record<string, unknown> = {}) {
    const { result, info } = (await this.call({ method: 'execute', command, params })) as { result: string; info: PhotoEngineInfo }
    this.info = info
    return result
  }

  /** RGBA8 of the area at (`x`, `y`) image pixels shown at `scale` screen pixels per pixel. */
  async render(x: number, y: number, scale: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'render', x, y, scale, width, height })) as ArrayBuffer)
  }

  /** RGBA8 of the image area (`x0`, `y0`)–(`x1`, `y1`), averaged down to exactly `width` × `height`. */
  async renderArea(x0: number, y0: number, x1: number, y1: number, width: number, height: number) {
    return new Uint8Array((await this.call({ method: 'renderArea', x0, y0, x1, y1, width, height })) as ArrayBuffer)
  }

  async commands() {
    return (await this.call({ method: 'commands' })) as KitsCommandView[]
  }

  /** The image as file bytes; it stays unsaved until `markSaved`. */
  async save() {
    return new Uint8Array((await this.call({ method: 'save' })) as ArrayBuffer)
  }

  async markSaved() {
    this.info = (await this.call({ method: 'markSaved' })) as PhotoEngineInfo
  }

  dispose() {
    this.worker.terminate()
    this.fail(new Error('the image was closed'))
  }
}
