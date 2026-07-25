import { describe, it, expect, vi } from 'vitest'
import { SearchService } from './searchService'
import type { WorkerInbound, WorkerOutbound, IndexableDoc } from '../types'

class MockWorker {
  onmessage: ((ev: MessageEvent<WorkerOutbound>) => void) | null = null
  posted: WorkerInbound[] = []
  postMessage(msg: WorkerInbound) {
    this.posted.push(msg)
    queueMicrotask(() => {
      if (msg.type === 'init') {
        this.onmessage?.(new MessageEvent('message', {
          data: { type: 'ready', requestId: msg.requestId, restoredFromDisk: false, docCount: 0 },
        }))
      } else if (msg.type === 'query') {
        this.onmessage?.(new MessageEvent('message', {
          data: { type: 'results', requestId: msg.requestId, hits: [], truncated: false },
        }))
      } else {
        this.onmessage?.(new MessageEvent('message', {
          data: { type: 'ack', requestId: msg.requestId },
        }))
      }
    })
  }
  terminate = vi.fn()

  /** Simulate an async worker error broadcast (not tied to a request) */
  fireError(message: string) {
    this.onmessage?.(new MessageEvent('message', {
      data: { type: 'error', requestId: '', message, recoverable: true },
    }))
  }
}

describe('SearchService', () => {
  it('init + query round-trip', async () => {
    const svc = new SearchService({ workerFactory: () => new MockWorker() as unknown as Worker })
    await svc.init('/vault')
    const hits = await svc.query('hello')
    expect(hits).toEqual([])
  })

  it('bulkLoad chunks into 200-doc batches', async () => {
    const worker = new MockWorker()
    const svc = new SearchService({ workerFactory: () => worker as unknown as Worker })
    await svc.init('/vault')
    const docs = Array.from({ length: 450 }, (_, i): IndexableDoc => ({
      id: `n${i}`, kind: 'note', vaultPath: 'a.md', title: 'a',
      body: `x ${i}`, tags: [], anchor: { kind: 'note', line: i + 1, ch: 0 },
    }))
    await svc.bulkLoad(docs)
    const bulkMsgs = worker.posted.filter(m => m.type === 'bulkLoad')
    expect(bulkMsgs).toHaveLength(3)
    // Each non-final batch must be exactly 200 docs; final batch is the remainder
    const sizes = bulkMsgs.map(m => (m as { docs: unknown[] }).docs.length)
    expect(sizes).toEqual([200, 200, 50])
    expect((bulkMsgs[2] as { isFinal: boolean }).isFinal).toBe(true)
    expect((bulkMsgs[0] as { isFinal: boolean }).isFinal).toBe(false)
    expect((bulkMsgs[1] as { isFinal: boolean }).isFinal).toBe(false)
  })

  it('propagates worker error messages to onError subscribers', async () => {
    const worker = new MockWorker()
    const svc = new SearchService({ workerFactory: () => worker as unknown as Worker })
    await svc.init('/vault')
    const received: string[] = []
    svc.onError(msg => received.push(msg))
    worker.fireError('index corrupt')
    // allow microtask to propagate
    await Promise.resolve()
    expect(received).toEqual(['index corrupt'])
  })
})
