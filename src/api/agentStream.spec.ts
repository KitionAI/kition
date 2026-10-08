import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionError, AgentStreamInterruptedError, readAgentMessageStream } from './agentStream'

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

describe('Agent stream completion', () => {
  it.each(['', '\n', '{"type":"model_delta","delta":"A partial article"}\n']) (
    'rejects EOF without a terminal frame: %j', async (text) => {
      const body = stream(text)
      await expect(readAgentMessageStream(body, {})).rejects.toBeInstanceOf(AgentStreamInterruptedError)
      expect(body.locked).toBe(false)
    },
  )

  it('preserves an artifact received before interruption without claiming completion', async () => {
    const artifact = { type: 'artifact', artifact: { id: 1, path: 'draft.md' } }
    const onEvent = vi.fn()
    await expect(readAgentMessageStream(stream(JSON.stringify(artifact)), { onEvent }))
      .rejects.toMatchObject({ code: 'agent_stream_interrupted' })
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(artifact)
  })

  it('decodes split frames and accepts a terminal frame without a trailing newline', async () => {
    const onDelta = vi.fn()
    const done = { type: 'done', extra_data: { message: { content: 'Saved' } } }
    const body = stream(`\n${JSON.stringify({ type: 'delta', delta: 'A → B' })}\r\n${JSON.stringify(done)}`)
    await expect(readAgentMessageStream(body, { onDelta })).resolves.toEqual(done)
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('A → B')
    expect(body.locked).toBe(false)
  })

  it('keeps runtime errors authoritative even after a done frame', async () => {
    await expect(readAgentMessageStream(stream('{"type":"done"}\n{"type":"error","message":"Write failed"}'), {}))
      .rejects.toThrow('Write failed')
  })

  it('rejects a terminal frame that explicitly reports a failed session', async () => {
    const frame = { type: 'done', extra_data: { session: { status: 'failed' } } }
    await expect(readAgentMessageStream(stream(JSON.stringify(frame)), {})).rejects.toBeInstanceOf(AgentExecutionError)
  })

  it('rejects malformed frames and releases the reader', async () => {
    const body = stream('{"type":')
    await expect(readAgentMessageStream(body, {})).rejects.toBeInstanceOf(SyntaxError)
    expect(body.locked).toBe(false)
  })

  it('keeps cancellation distinct from unconfirmed completion', async () => {
    const abort = new AbortController()
    abort.abort()
    const body = stream('{"type":"done"}')
    await expect(readAgentMessageStream(body, { signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(body.locked).toBe(false)
  })
})
