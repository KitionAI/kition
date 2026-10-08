import i18next from 'i18next'
import type { AgentEvent } from '@/api/agent'
import { AgentExecutionError, AgentStreamInterruptedError } from '@/api/agentStream'

/** Client observations stay distinct from authoritative runtime task outcomes. */
export function describeAgentTurnFailure(error: unknown, sessionId: number, messageId: number) {
  const interrupted = error instanceof AgentStreamInterruptedError
  const failed = error instanceof AgentExecutionError
  const canceled = error != null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  const titleKey = canceled ? 'stopped' : 'completionUnknown'
  const message = interrupted
    ? i18next.t('timeline.activity.interruptedDetail', { ns: 'agent' })
    : canceled
      ? i18next.t('timeline.activity.stopped', { ns: 'agent' })
      : error instanceof Error ? error.message : i18next.t('timeline.event.taskFailed', { ns: 'agent' })
  const event: AgentEvent = {
    id: -Date.now(), session_id: sessionId, user_id: 0, message_id: messageId,
    event_type: failed ? 'task.failed' : 'client.turn.interrupted', status: failed ? 'failed' : 'pending',
    label: i18next.t(failed ? 'timeline.event.taskFailed' : `timeline.activity.${titleKey}`, { ns: 'agent' }),
    message, data: { reason: canceled ? 'canceled' : 'unconfirmed' },
    created_at: new Date().toISOString(),
  }
  return { message, event, canceled }
}
