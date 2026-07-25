import type { WorkerInbound, WorkerOutbound, WorkerProgress } from '../types'

type Resolver = (out: WorkerOutbound) => void

export class WorkerClient {
  private pending = new Map<string, Resolver>()
  private onProgress: ((p: WorkerProgress) => void) | null = null
  private onErrorCbs = new Set<(msg: string) => void>()

  constructor(private worker: Worker) {
    worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      const out = ev.data
      if (out.type === 'progress') {
        this.onProgress?.(out)
        return
      }
      if (out.type === 'error') {
        this.onErrorCbs.forEach(cb => cb(out.message))
        const resolver = this.pending.get(out.requestId)
        if (resolver) {
          this.pending.delete(out.requestId)
          resolver(out)
        }
        return
      }
      const resolver = this.pending.get(out.requestId)
      if (resolver) {
        this.pending.delete(out.requestId)
        resolver(out)
      }
    }
  }

  setOnProgress(cb: (p: WorkerProgress) => void) { this.onProgress = cb }

  onError(cb: (msg: string) => void): () => void {
    this.onErrorCbs.add(cb)
    return () => { this.onErrorCbs.delete(cb) }
  }

  send(msg: WorkerInbound, timeoutMs = 5000): Promise<WorkerOutbound> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId)
        reject(new Error(`worker timeout for ${msg.type} (${msg.requestId})`))
      }, timeoutMs)
      this.pending.set(msg.requestId, (out) => {
        clearTimeout(timer)
        resolve(out)
      })
      this.worker.postMessage(msg)
    })
  }

  terminate() { this.worker.terminate() }
}
