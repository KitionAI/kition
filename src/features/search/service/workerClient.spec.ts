import { describe, it, expect, vi } from 'vitest'
import { WorkerClient } from './workerClient'
import type { WorkerInbound, WorkerOutbound } from '../types'

class MockWorker {
  onmessage: ((ev: MessageEvent<WorkerOutbound>) => void) | null = null
  postedMessages: WorkerInbound[] = []
  postMessage(msg: WorkerInbound) {
    this.postedMessages.push(msg)
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
}

describe('WorkerClient', () => {
  it('init resolves with ready payload', async () => {
    const w = new MockWorker()
    const client = new WorkerClient(w as unknown as Worker)
    const res = await client.send({ type: 'init', requestId: '1', rootPath: '/x', rootHash: 'abc' })
    expect(res).toMatchObject({ type: 'ready', docCount: 0 })
  })

  it('correlates concurrent requests by requestId', async () => {
    const w = new MockWorker()
    const client = new WorkerClient(w as unknown as Worker)
    const [a, b] = await Promise.all([
      client.send({ type: 'remove', requestId: 'a', ids: ['x'] }),
      client.send({ type: 'remove', requestId: 'b', ids: ['y'] }),
    ])
    expect((a as { requestId: string }).requestId).toBe('a')
    expect((b as { requestId: string }).requestId).toBe('b')
  })
})
