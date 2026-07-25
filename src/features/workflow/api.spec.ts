import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock('@/api/request', () => ({
  default: requestMock,
}))

import { createWorkflow } from '@/features/workflow/api'

afterEach(() => {
  requestMock.post.mockReset()
})

describe('createWorkflow', () => {
  it('POSTs the payload and unwraps {workflow}', async () => {
    const stub = {
      id: 'auto_x',
      name: 'My welcome email',
      enabled: false,
      trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 't1' },
      action: { nodeId: 'action_1', type: 'send_email', to: 'you@example.com', subject: { parts: [{ kind: 'text' as const, text: 'Hi' }] }, body: { parts: [{ kind: 'text', text: 'hi' }] } },
    }
    requestMock.post.mockResolvedValueOnce({ workflow: stub })

    const result = await createWorkflow({
      name: 'My welcome email',
      description: '',
      enabled: false,
      trigger: { type: 'record_created', documentId: 'd1', tableId: 't1' },
      action: { type: 'send_email', connectionId: '', to: 'you@example.com', subject: { parts: [{ kind: 'text' as const, text: 'Hi' }] }, body: { parts: [{ kind: 'text', text: 'hi' }] } },
    })

    expect(result.id).toBe('auto_x')
    expect(requestMock.post).toHaveBeenCalledTimes(1)
    const [url, payload] = requestMock.post.mock.calls[0] as [string, unknown]
    expect(url).toContain('/v1/workflows')
    expect((payload as any).trigger.tableId).toBe('t1')
  })

  it('dispatches kition:workflow:changed on success', async () => {
    const stub = {
      id: 'auto_y',
      name: 'X',
      enabled: false,
      trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 't1' },
      action: { nodeId: 'action_1', type: 'send_email', to: 'a@b.c', subject: { parts: [{ kind: 'text' as const, text: 'S' }] }, body: { parts: [{ kind: 'text', text: 't' }] } },
    }
    requestMock.post.mockResolvedValueOnce({ workflow: stub })

    const listener = vi.fn()
    window.addEventListener('kition:workflow:changed', listener)
    await createWorkflow({
      name: 'X',
      description: '',
      enabled: false,
      trigger: { type: 'record_created', documentId: 'd1', tableId: 't1' },
      action: { type: 'send_email', connectionId: '', to: 'a@b.c', subject: { parts: [{ kind: 'text' as const, text: 'S' }] }, body: { parts: [{ kind: 'text', text: 't' }] } },
    })
    window.removeEventListener('kition:workflow:changed', listener)
    expect(listener).toHaveBeenCalled()
  })
})
