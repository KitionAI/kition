import { afterEach, describe, expect, it } from 'vitest'
import { setCurrentLocale } from '@/i18n'
import enAgent from '@/i18n/locales/en-US/agent.json'
import zhAgent from '@/i18n/locales/zh-CN/agent.json'
import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { buildAgentRunLogItems } from './agentTimeline'
import { getAgentTimelineDict, resolveAgentTimelineLocale } from './agentTimelineI18n'
import { applySessionEvent, emptyAgentSessionView, markInterrupted } from './agentSessionView'

const opened = ([
  { seq: 1, at: 1, type: 'turn/start', turn: 1 },
  { seq: 2, at: 2, type: 'step/start', turn: 1, step: 1 },
  {
    seq: 3, at: 3, type: 'llm/retry', retryId: 'agent:1#1.1', turn: 1, step: 1, provider: 'openai', mode: 'normal',
    policyKey: 'engine', retry: 2, maxRetries: 5, delayMs: 0, failure: { message: 'closed', code: 'connection_closed' },
  },
] as AgentSessionEventsSessionEvent[]).reduce(applySessionEvent, emptyAgentSessionView())

afterEach(async () => { await setCurrentLocale('en-US') })

describe('Agent outcome presentation', () => {
  it('does not infer task completion from a successful tool', () => {
    const [turn] = markInterrupted(opened).turns
    const outcome = buildAgentRunLogItems({ turn, busy: false }).find((item) => item.key === 'outcome')
    expect(outcome?.title).toBe(enAgent.timeline.activity.completionUnknown)
  })

  it('localizes interruption, reconnect, and tool labels and responds to locale changes', async () => {
    await setCurrentLocale('zh-CN')
    const locale = resolveAgentTimelineLocale('zh-CN')
    const dict = getAgentTimelineDict(locale)
    expect(dict.toolDisplayName.document_write).toBe(zhAgent.timeline.toolDisplayName.document_write)
    const [turn] = markInterrupted(opened).turns
    const items = buildAgentRunLogItems({ turn, busy: false, locale })
    expect(items[0].title).toBe(dict.event.reconnecting(2, 5))
    expect(items[1].title).toBe(zhAgent.timeline.activity.completionUnknown)
    expect(items[1].detail).toBe(zhAgent.timeline.activity.interruptedDetail)
    await setCurrentLocale('en-US')
    const again = buildAgentRunLogItems({ turn, busy: false })
    expect(again[1].title).toBe(enAgent.timeline.activity.completionUnknown)
  })

  it('falls back for unsupported locales and interpolates plural reconnect labels', () => {
    expect(resolveAgentTimelineLocale('unsupported')).toBe('en-US')
    expect(getAgentTimelineDict().event.reconnectingInSeconds(1)).toBe('Retrying in 1 second')
    expect(getAgentTimelineDict().event.reconnectingInSeconds(2)).toBe('Retrying in 2 seconds')
  })
})
