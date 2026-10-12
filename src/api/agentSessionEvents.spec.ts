import { beforeEach, describe, expect, it, vi } from 'vitest'

import { expectMatchesContract } from '@/test/contracts'
import request from './request'
import { listAgentSessionEvents } from './agent'
import type { AgentSessionEventsPage } from './generated/agent-session-events'

vi.mock('./request', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

describe('listAgentSessionEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads the session event log after a cursor', async () => {
    const page: AgentSessionEventsPage = {
      items: [
        { seq: 4, at: 1760140800000, type: 'turn/start', turn: 2 },
        {
          seq: 5,
          at: 1760140800001,
          type: 'tool/result',
          callId: 'call_1',
          name: 'artifact_write',
          value: { path: 'Notes/plan.md' },
          content: [{ type: 'text', text: 'Saved Notes/plan.md' }],
          isError: false,
        },
        { seq: 6, at: 1760140800002, type: 'turn/end', turn: 2, reason: 'completed' },
      ],
      next_after: 6,
    }
    expectMatchesContract(page, 'agent-session-events', 'page')
    vi.mocked(request.get).mockResolvedValue(page as never)

    await expect(listAgentSessionEvents(7, 3)).resolves.toEqual(page)

    const [path, config] = vi.mocked(request.get).mock.calls[0]
    expect(path).toBe('/v1/agent/sessions/7/session-events')
    expect(config).toMatchObject({ params: { after: 3 } })
  })

  it('starts from the first event without a cursor', async () => {
    const empty: AgentSessionEventsPage = { items: [] }
    expectMatchesContract(empty, 'agent-session-events', 'page')
    vi.mocked(request.get).mockResolvedValue(empty as never)

    await listAgentSessionEvents(7)
    await listAgentSessionEvents(7, -1)
    await listAgentSessionEvents(7, 0)

    const params = vi.mocked(request.get).mock.calls.map(([, config]) => config?.params)
    expect(params).toEqual([{}, {}, { after: 0 }])
  })
})
