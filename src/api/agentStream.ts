import type { AgentStreamEvent } from './agentTypes'

export class AgentExecutionError extends Error {
  constructor(message = 'Agent execution failed') {
    super(message)
    this.name = 'AgentExecutionError'
  }
}

export class AgentStreamInterruptedError extends Error {
  readonly code = 'agent_stream_interrupted'

  constructor() {
    super('The connection ended before task completion was confirmed. Check saved results before retrying.')
    this.name = 'AgentStreamInterruptedError'
  }
}

/** Transport EOF is not a task outcome. Preserve delivered events, but require
 * the runtime's terminal frame before the caller can record a completed request. */
export async function readAgentMessageStream(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal
    onEvent?: (event: AgentStreamEvent) => void
    onDelta?: (delta: string) => void
  },
): Promise<AgentStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneEvent: AgentStreamEvent | undefined

  function consume(line: string) {
    if (!line.trim()) return
    const event = JSON.parse(line) as AgentStreamEvent
    if (event.type === 'error') {
      throw new AgentExecutionError(event.message || undefined)
    }
    if (event.type === 'delta' && event.delta) options.onDelta?.(event.delta)
    options.onEvent?.(event)
    if (event.type === 'done') {
      if (event.extra_data?.session?.status === 'failed' || event.session?.status === 'failed') {
        throw new AgentExecutionError(event.message || undefined)
      }
      doneEvent = event
    }
  }

  try {
    while (true) {
      options.signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) consume(line)
    }
    options.signal?.throwIfAborted()
    consume(buffer + decoder.decode())
    if (!doneEvent) throw new AgentStreamInterruptedError()
    return doneEvent
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
