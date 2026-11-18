import { describe, expect, it, vi } from 'vitest'
import { AgentStreamInterruptedError, readAgentMessageStream } from './agentStream'

function stream(text: string) {
  // Byte-sized chunks exercise JSON, line, and multi-byte UTF-8 boundaries.
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}

const status = (value: 'running' | 'idle') => ({
  jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'agent:1', status: value },
})
const text = (delta: string) => ({
  jsonrpc: '2.0',
  method: 'agent/assistant-stream',
  params: {
    sessionId: 'agent:1',
    frame: { type: 'chunk', attemptId: 'agent:1#1.1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: delta } },
  },
})
const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n')

describe('Agent stream completion', () => {
  it.each(['', '\n', `${lines(status('running'), text('A partial article'))}\n`])(
    'rejects EOF before idle: %j', async (body) => {
      const readable = stream(body)
      await expect(readAgentMessageStream(readable, {})).rejects.toBeInstanceOf(AgentStreamInterruptedError)
      expect(readable.locked).toBe(false)
    },
  )

  it('keeps notifications received before an interruption', async () => {
    const onNotification = vi.fn()
    await expect(readAgentMessageStream(stream(lines(status('running'), text('Hi'))), { onNotification }))
      .rejects.toMatchObject({ code: 'agent_stream_interrupted' })
    expect(onNotification).toHaveBeenCalledTimes(2)
    expect(onNotification).toHaveBeenLastCalledWith(text('Hi'))
  })

  it('decodes split lines and resolves on idle without a trailing newline', async () => {
    const onNotification = vi.fn()
    const body = stream(`\n${JSON.stringify(text('A → B'))}\r\n${JSON.stringify(status('idle'))}`)
    await expect(readAgentMessageStream(body, { onNotification })).resolves.toBeUndefined()
    expect(onNotification).toHaveBeenNthCalledWith(1, text('A → B'))
    expect(onNotification).toHaveBeenNthCalledWith(2, status('idle'))
    expect(body.locked).toBe(false)
  })

  it('stops reading after idle', async () => {
    const onNotification = vi.fn()
    await readAgentMessageStream(stream(lines(status('idle'), text('late'))), { onNotification })
    expect(onNotification).toHaveBeenCalledExactlyOnceWith(status('idle'))
  })

  it('rejects malformed lines and releases the reader', async () => {
    const body = stream('{"jsonrpc":')
    await expect(readAgentMessageStream(body, {})).rejects.toBeInstanceOf(SyntaxError)
    expect(body.locked).toBe(false)
  })

  it('keeps cancellation distinct from unconfirmed completion', async () => {
    const abort = new AbortController()
    abort.abort()
    const body = stream(JSON.stringify(status('idle')))
    await expect(readAgentMessageStream(body, { signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(body.locked).toBe(false)
  })
})
