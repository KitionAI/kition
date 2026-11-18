import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'

import { streamAgentMessage } from './agent'

vi.mock('@/services/desktop', () => ({
  getApiBaseURL: () => 'http://runtime.test',
  resolveApiURL: (path: string) => `http://runtime.test${path}`,
}))

const idle = JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'agent:7', status: 'idle' } })

/** A logged tool result notification. */
function toolResult(callId: string) {
  return {
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId: 'agent:9',
      event: {
        seq: 5, at: 1, type: 'tool/result', callId, name: 'document_write', isError: false,
        content: [{ type: 'text', text: 'Wrote Notes/Report.md' }],
        value: { path: 'Notes/Report.md' },
      },
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('streamAgentMessage', () => {
  it('rejects a refused turn with the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"code":409,"message":"This session is still answering."}',
      { status: 409 },
    )))

    await expect(streamAgentMessage({ sessionId: 7, content: 'again' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('still answering'),
    })
  })

  it('keeps a slow stream open beyond ordinary request timeouts', async () => {
    vi.useFakeTimers()
    const onNotification = vi.fn()
    const abort = new AbortController()
    const encoder = new TextEncoder()
    const running = JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'agent:10', status: 'running' } })
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${running}\n`))
          setTimeout(() => {
            controller.enqueue(encoder.encode([JSON.stringify(toolResult('slow-call')), idle, ''].join('\n')))
            controller.close()
          }, 9 * 60_000)
        },
      }),
    ))
    vi.stubGlobal('fetch', fetchMock)

    const completed = vi.fn()
    const streaming = streamAgentMessage({
      sessionId: 10, content: 'Write a detailed report', signal: abort.signal, onNotification,
    }).then(completed)
    await vi.advanceTimersByTimeAsync(8 * 60_000)
    expect(completed).not.toHaveBeenCalled()
    expect(onNotification).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(abort.signal)
    expect(abort.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    await streaming
    expect(completed).toHaveBeenCalledOnce()
    expect(onNotification).toHaveBeenCalledWith(toolResult('slow-call'))
  })

  it('sends a command approval by the paused call id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`${idle}\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const shellApproval = { call_id: 'call_1', decision: 'allow_once' as const }
    expectMatchesContract(shellApproval, 'agent-shell-approval', 'response')

    await streamAgentMessage({ sessionId: 7, content: 'Approved', hideUserMessage: true, shellApproval })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      hide_user_message: true,
      shell_approval: shellApproval,
    })
  })
})
