import { describe, expect, it } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import {
  buildAgentRunLogItems,
  formatAgentErrorSummary,
  formatAgentRunLogExpandedDetail,
} from './agentTimeline'
import { applySessionEvent, emptyAgentSessionView, type AgentTurnView } from './agentSessionView'

type Body = { type: string } & Record<string, unknown>

/** The one turn of a log made of `bodies` after `turn/start`, numbered from seq 1. */
function turnOf(bodies: Body[]): AgentTurnView {
  const list = [{ type: 'turn/start', turn: 1 }, ...bodies]
    .map((body, index) => ({ seq: index + 1, at: Date.parse('2026-05-29T00:00:00.000Z') + index, ...body }) as AgentSessionEventsSessionEvent)
  return list.reduce(applySessionEvent, emptyAgentSessionView()).turns[0]
}

const step = (n: number): Body => ({ type: 'step/start', turn: 1, step: n })
const call = (callId: string, name: string, args: unknown = {}): Body => ({ type: 'tool/call', callId, name, arguments: args })
const result = (callId: string, name: string, output: unknown): Body => ({
  type: 'tool/result', callId, name, isError: false, content: [], value: { name, summary: 'Done', output },
})
const message = (content: string, toolCalls = 0): Body => ({
  type: 'assistant/message', content, stopReason: 'stop', model: 'm',
  ...(toolCalls ? { toolCalls: Array.from({ length: toolCalls }, (_, i) => ({ callId: `c${i}`, name: 'document_read', arguments: {} })) } : {}),
})
const end = (reason: string, error?: string): Body => ({ type: 'turn/end', turn: 1, reason, ...(error ? { error } : {}) })
const retry = (n: number): Body => ({
  type: 'llm/retry', retryId: 'agent:1#1.1', turn: 1, step: 1, provider: 'openai', mode: 'normal', policyKey: 'engine',
  retry: n, maxRetries: 5, delayMs: 2000, failure: { message: 'handshake', code: 'tls_handshake_timeout' },
})

describe('buildAgentRunLogItems', () => {
  const done = turnOf([
    step(1), message('', 1), call('c1', 'document_read', { path: 'Docs/a.md' }), result('c1', 'document_read', { path: 'Docs/a.md' }),
    step(2), message('Done.'), end('completed'),
  ])

  it('shows tool runs and the outcome, and model steps only in debug mode', () => {
    const titles = buildAgentRunLogItems({ turn: done, busy: false, locale: 'en-US' }).map((item) => item.title)
    expect(titles).toEqual(['Read document completed', 'Task completed'])
    const debug = buildAgentRunLogItems({ turn: done, busy: false, debug: true, locale: 'en-US' }).map((item) => item.title)
    expect(debug).toContain('AI backend called')
    expect(debug).toContain('AI backend turn completed')
  })

  it('keeps unfinished runs unconfirmed when the stream stopped', () => {
    const open = turnOf([step(1), call('c1', 'document_write', { path: 'Docs/a.md' })])
    expect(buildAgentRunLogItems({ turn: open, busy: false }).map((item) => item.status)).toEqual(['pending'])
    const running = buildAgentRunLogItems({ turn: open, busy: true })
    expect(running.map((item) => item.status)).toEqual(['running'])
  })

  it('shows reconnect progress with earlier retries settled', () => {
    const items = buildAgentRunLogItems({ turn: turnOf([step(1), retry(1), retry(2)]), busy: true, locale: 'en-US' })
    const retries = items.filter((item) => item.key.startsWith('retry-'))
    expect(retries.map((item) => [item.title, item.status])).toEqual([
      ['Reconnecting... 1/5', 'completed'],
      ['Reconnecting... 2/5', 'running'],
    ])
    expect(retries[1].detail).toBe('Retrying in 2 seconds · Secure connection timed out')
  })

  it('names how a turn failed, stopped, or hit the step limit', () => {
    const failed = buildAgentRunLogItems({ turn: turnOf([step(1), end('failed', 'Error: provider refused')]), busy: false })
    expect(failed.at(-1)).toMatchObject({ title: 'Task failed', detail: 'provider refused', status: 'failed' })
    const limit = buildAgentRunLogItems({ turn: turnOf([step(1), end('step-limit')]), busy: false })
    expect(limit.at(-1)?.detail).toContain('most model steps')
    const stopped = buildAgentRunLogItems({ turn: turnOf([step(1), end('cancelled')]), busy: false })
    expect(stopped.at(-1)?.title).toBe('Task stopped')
  })

  it('says the outcome is unknown for an interrupted turn', () => {
    const turn = { ...turnOf([step(1)]), interrupted: true }
    const [item] = buildAgentRunLogItems({ turn, busy: false, locale: 'en-US' })
    expect(item).toMatchObject({ title: 'Completion not confirmed', status: 'pending' })
  })

  it('dates an unknown outcome at the turn\'s last event, not the clock', () => {
    const turn = { ...turnOf([step(1), call('c1', 'document_read'), result('c1', 'document_read', {})]), interrupted: true }
    const outcome = buildAgentRunLogItems({ turn, busy: false }).find((item) => item.key === 'outcome')
    // `tool/result` is the fourth event: 3 ms after the turn started.
    expect(outcome?.createdAt).toBe('2026-05-29T00:00:00.003Z')
  })

  it('shows the model thinking while busy without a running row', () => {
    const turn = turnOf([step(1), call('c1', 'document_read'), result('c1', 'document_read', {})])
    const model = buildAgentRunLogItems({ turn, busy: true, locale: 'en-US' }).find((item) => item.kind === 'model')
    expect(model?.title).toBe('Processing tool results')
    expect(model?.detail).toContain('Read Document')
    const expanded = formatAgentRunLogExpandedDetail(model!, 'en-US')
    expect(expanded).not.toContain('processing_tool_result')
    expect(expanded).toContain('Read Document')
  })

  it('streams the live text of its own turn', () => {
    const turn = turnOf([step(1)])
    const items = buildAgentRunLogItems({
      turn, busy: true, live: { attemptId: 'a', turn: 1, step: 1, text: 'Drafting', toolArgs: {} },
    })
    expect(items.find((item) => item.kind === 'final')?.detail).toBe('Drafting')
  })

  it('lists delivered files no tool row names', () => {
    const turn = turnOf([
      step(1), call('c1', 'image_search', { query: 'fox' }), result('c1', 'image_search', { images: [] }),
      { type: 'deliverables/presented', turn: 1, callId: 'c1', files: [{ path: 'Agent/fox.png', description: 'Fox' }] },
    ])
    const artifact = buildAgentRunLogItems({ turn, busy: false, locale: 'en-US' }).find((item) => item.kind === 'artifact')
    expect(artifact).toMatchObject({ title: 'Save artifact', detail: 'Agent/fox.png' })
    expect(formatAgentRunLogExpandedDetail(artifact!, 'en-US')).toContain('Fox')
  })

  it('shows a paused command as pending until its approval is decided', () => {
    const paused: Body[] = [
      step(1), call('c1', 'exec_command', { cmd: ['ls'] }),
      { ...result('c1', 'exec_command', { requires: 'approval', command: 'ls' }), meta: {
        kind: 'shell.approval', command: 'ls', reason: 'r', requires: 'approval', decision: 'prompt',
      } },
      { type: 'approval/asked', id: 'approval:c1', toolName: 'exec_command', callId: 'c1' },
      end('awaiting-approval'),
    ]
    expect(buildAgentRunLogItems({ turn: turnOf(paused), busy: false })[0].status).toBe('pending')
    const decided = [...paused, { type: 'approval/decided', id: 'approval:c1', outcome: 'rejected' }]
    expect(buildAgentRunLogItems({ turn: turnOf(decided), busy: false })[0].status).toBe('failed')
  })

  it('uses English section labels for the expanded tool detail', () => {
    const turn = turnOf([step(1), call('c7', 'document_read', { path: '/docs/a.md' }), result('c7', 'document_read', { path: '/docs/a.md', text: 'hello' })])
    const toolItem = buildAgentRunLogItems({ turn, busy: false, locale: 'en-US' }).find((item) => item.kind === 'tool')
    const expanded = formatAgentRunLogExpandedDetail(toolItem!, 'en-US')
    expect(expanded).toContain('Tool')
    expect(expanded).toContain('Input')
    expect(expanded).toContain('Output')
  })
})

describe('formatAgentErrorSummary', () => {
  it('extracts a concise message from a structured error payload', () => {
    expect(formatAgentErrorSummary(JSON.stringify({
      error: {
        message: 'The requested document could not be found.',
        type: 'not_found',
        trace_id: 'internal-trace',
      },
    }))).toBe('The requested document could not be found.')
  })

  it('removes technical prefixes, stack traces, and request identifiers', () => {
    expect(formatAgentErrorSummary([
      'Tool execution failed: Error: Permission denied',
      '    at readDocument (internal/tool.js:42:7)',
      'request_id=req_internal',
    ].join('\n'))).toBe('Permission denied')
  })
})
