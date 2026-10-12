import type { AgentStreamNotification } from './generated/agent-stream'

export type { AgentStreamNotification } from './generated/agent-stream'

export class AgentStreamInterruptedError extends Error {
  readonly code = 'agent_stream_interrupted'

  constructor() {
    super('The connection ended before task completion was confirmed. Check saved results before retrying.')
    this.name = 'AgentStreamInterruptedError'
  }
}

/**
 * Reads the NDJSON notifications of a turn (`contracts/runtime/agent-stream.schema.json`)
 * and resolves on `session.status idle`. Transport EOF before idle is not a
 * task outcome: delivered notifications are kept, but the caller must read the
 * session log to learn how the turn ended.
 */
export async function readAgentMessageStream(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal
    onNotification?: (notification: AgentStreamNotification) => void
  },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idle = false

  function consume(line: string) {
    if (!line.trim() || idle) return
    const notification = JSON.parse(line) as AgentStreamNotification
    options.onNotification?.(notification)
    if (notification.method === 'session.status' && notification.params.status === 'idle') idle = true
  }

  try {
    while (!idle) {
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
    if (!idle) throw new AgentStreamInterruptedError()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
