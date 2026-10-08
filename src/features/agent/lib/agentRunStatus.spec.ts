import { afterEach, describe, expect, it } from 'vitest'
import { setCurrentLocale } from '@/i18n'
import enAgent from '@/i18n/locales/en-US/agent.json'
import zhAgent from '@/i18n/locales/zh-CN/agent.json'
import type { AgentEvent, AgentToolCall } from '@/api/agent'
import { AgentExecutionError, AgentStreamInterruptedError } from '@/api/agentStream'
import { describeAgentTurnFailure } from './agentTurnFailure'
import { buildAgentRunLogItems, formatCurrentAgentActivity } from './agentTimeline'
import { getAgentTimelineDict, resolveAgentTimelineLocale } from './agentTimelineI18n'

const tool: AgentToolCall = {
  id: 1, session_id: 1, user_id: 1, tool_name: 'document_write', status: 'completed',
  created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:01Z',
}
const event: AgentEvent = {
  id: 2, session_id: 1, user_id: 1, event_type: 'model.reconnecting',
  status: 'running', created_at: '2026-09-30T00:00:02Z',
  data: { attempt: 2, max_retries: 5, reason: 'connection_closed' },
}
const idle = { toolCalls: [tool], events: [], busy: false, streamingText: '' }

afterEach(async () => { await setCurrentLocale('en-US') })

describe('Agent outcome presentation', () => {
  it('does not infer task completion from a successful tool', () => {
    expect(formatCurrentAgentActivity(idle)).toBe(enAgent.timeline.activity.completionUnknown)
    expect(formatCurrentAgentActivity({ ...idle, events: [{ ...event, event_type: 'task.completed', status: 'completed' }] }))
      .toBe(enAgent.timeline.activity.taskCompleted)
  })

  it('keeps unfinished operations unconfirmed when transport stops', () => {
    const items = buildAgentRunLogItems({ ...idle, artifacts: [], events: [event], toolCalls: [{ ...tool, status: 'running' }] })
    expect(items.map((item) => item.status)).toEqual(['pending', 'pending'])
  })

  it('localizes interruption, reconnect, and tool labels and responds to locale changes', async () => {
    await setCurrentLocale('zh-CN')
    const locale = resolveAgentTimelineLocale('zh-CN')
    const dict = getAgentTimelineDict(locale)
    expect(dict.toolDisplayName.document_write).toBe(zhAgent.timeline.toolDisplayName.document_write)
    const failure = describeAgentTurnFailure(new AgentStreamInterruptedError(), 1, 17)
    expect(failure.message).toBe(zhAgent.timeline.activity.interruptedDetail)
    expect(failure.event.message_id).toBe(17)
    const items = buildAgentRunLogItems({ ...idle, locale, toolCalls: [], artifacts: [], events: [event, failure.event] })
    expect(items[0].title).toBe(dict.event.reconnecting(2, 5))
    expect(items[1].title).toBe(zhAgent.timeline.activity.completionUnknown)
    expect(items[1].status).toBe('pending')
    await setCurrentLocale('en-US')
    const translatedAgain = buildAgentRunLogItems({ ...idle, toolCalls: [], artifacts: [], events: [failure.event] })
    expect(translatedAgain[0].title).toBe(enAgent.timeline.activity.completionUnknown)
    expect(translatedAgain[0].detail).toBe(enAgent.timeline.activity.interruptedDetail)
  })

  it('distinguishes cancellation and preserves a runtime error message', () => {
    const canceled = describeAgentTurnFailure(new DOMException('Aborted', 'AbortError'), 1, 17)
    expect(canceled.canceled).toBe(true)
    expect(formatCurrentAgentActivity({ ...idle, events: [canceled.event] })).toBe(enAgent.timeline.activity.stopped)
    expect(describeAgentTurnFailure(new Error('Write rejected'), 1, 17).message).toBe('Write rejected')
    const failed = describeAgentTurnFailure(new AgentExecutionError('Write rejected'), 1, 17)
    expect(failed.event).toMatchObject({ event_type: 'task.failed', status: 'failed', message: 'Write rejected' })
  })

  it('falls back for unsupported locales and interpolates plural reconnect labels', () => {
    expect(resolveAgentTimelineLocale('unsupported')).toBe('en-US')
    expect(getAgentTimelineDict().event.reconnectingInSeconds(1)).toBe('Retrying in 1 second')
    expect(getAgentTimelineDict().event.reconnectingInSeconds(2)).toBe('Retrying in 2 seconds')
  })
})
