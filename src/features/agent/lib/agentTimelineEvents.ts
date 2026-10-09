import { toIsoTimestamp } from '@/lib/timestamps'
import type { AgentEvent, AgentSkillSpec } from '@/api/agent'
import type { AgentRunLogItem, AgentTaskStep } from './agentTimelineTypes'
import { getAgentTimelineDict, getAgentToolDisplayName, type AgentTimelineLocale } from './agentTimelineI18n'
import { compactAgentRunDetail } from './agentTimelineText'

export function normalizeAgentTaskStepStatus(status?: string): AgentTaskStep['status'] {
  if (status === 'failed') {
    return 'failed'
  }
  if (status === 'running') {
    return 'running'
  }
  if (status === 'completed') {
    return 'completed'
  }
  return 'pending'
}

export function formatAgentRunLogEvent(
  event: AgentEvent,
  busy: boolean,
  completedModelTurns: Set<number>,
  latestReconnectAttemptByTurn: Map<number, number>,
  locale: AgentTimelineLocale,
): AgentRunLogItem | null {
  const status = normalizeAgentEventStatus(event, busy, completedModelTurns, latestReconnectAttemptByTurn)
  const title = formatAgentRunLogEventTitle(event, status, locale)
  if (!title) {
    return null
  }
  return {
    key: `event-${event.id}`,
    kind: event.event_type === 'response.completed' ? 'final' : 'event',
    title,
    detail: formatAgentRunLogEventDetail(event, status, locale),
    status,
    payload: formatAgentRunLogEventPayload(event),
    createdAt: toIsoTimestamp(event.created_at),
  }
}

function normalizeAgentEventStatus(
  event: AgentEvent,
  busy: boolean,
  completedModelTurns: Set<number>,
  latestReconnectAttemptByTurn: Map<number, number>,
): AgentTaskStep['status'] {
  const turn = agentEventTurn(event)
  if (event.event_type === 'model.reconnecting') {
    if (completedModelTurns.has(turn)) {
      return 'completed'
    }
    const latestAttempt = latestReconnectAttemptByTurn.get(turn) || 0
    if (agentReconnectAttempt(event) < latestAttempt) {
      return 'completed'
    }
  }
  if (
    turn > 0
    && completedModelTurns.has(turn)
    && (
      event.event_type === 'model.turn.started'
      || event.event_type === 'model.delta'
      || event.event_type === 'model.tool_call.delta'
    )
  ) {
    return 'completed'
  }
  const normalized = normalizeAgentTaskStepStatus(event.status)
  if (!busy && normalized === 'running') {
    return 'pending'
  }
  return normalized
}

function formatAgentRunLogEventTitle(
  event: AgentEvent,
  status: AgentTaskStep['status'],
  locale: AgentTimelineLocale,
) {
  const dict = getAgentTimelineDict(locale)
  if (event.event_type === 'task.started') {
    return status === 'running' ? dict.event.understandingTask : dict.event.taskUnderstood
  }
  if (event.event_type === 'skill.enabled') {
    return dict.event.enableSkills
  }
  if (event.event_type === 'prompt.sent') {
    return dict.event.sendModelRequest
  }
  if (event.event_type === 'model.turn.started') {
    return status === 'running' ? dict.event.callingBackend : dict.event.backendCalled
  }
  if (event.event_type === 'model.reconnecting') {
    const attempt = agentReconnectAttempt(event)
    const maxRetries = agentReconnectMaxRetries(event)
    if (attempt > 0 && maxRetries > 0) {
      return dict.event.reconnecting(attempt, maxRetries)
    }
    return event.message || event.label || dict.event.reconnecting(1, 5)
  }
  if (event.event_type === 'model.delta') {
    return status === 'running' ? dict.event.backendStreaming : dict.event.backendReturned
  }
  if (event.event_type === 'model.tool_call.delta') {
    const toolName = typeof event.data?.tool_name === 'string' ? event.data.tool_name : ''
    return toolName
      ? dict.event.generatingToolArgs(getAgentToolDisplayName(toolName, locale))
      : dict.event.generatingToolArgsAnon
  }
  if (event.event_type === 'model.tool_call.ready') {
    const toolName = typeof event.data?.tool_name === 'string' ? event.data.tool_name : ''
    return toolName
      ? dict.event.toolCallGenerated(getAgentToolDisplayName(toolName, locale))
      : dict.event.toolCallGeneratedAnon
  }
  if (event.event_type === 'model.turn.completed') {
    return dict.event.backendTurnCompleted
  }
  if (event.event_type === 'response.completed') {
    return dict.event.finalizeResponse
  }
  if (event.event_type === 'client.turn.interrupted') {
    return event.data?.reason === 'canceled' ? dict.activity.stopped : dict.activity.completionUnknown
  }
  if (event.event_type === 'task.completed') return dict.event.taskCompleted
  if (event.event_type === 'task.failed') return dict.event.taskFailed
  return event.label || event.message || event.event_type
}

function formatAgentRunLogEventDetail(
  event: AgentEvent,
  status: AgentTaskStep['status'] | undefined,
  locale: AgentTimelineLocale,
) {
  const dict = getAgentTimelineDict(locale)
  if (event.event_type === 'client.turn.interrupted') {
    return event.data?.reason === 'canceled' ? dict.activity.stopped : dict.activity.interruptedDetail
  }
  if (event.event_type === 'skill.enabled' && Array.isArray(event.data?.skills)) {
    const names = event.data.skills
      .map((skill: Partial<AgentSkillSpec>) => skill?.name)
      .filter((name: unknown): name is string => typeof name === 'string' && Boolean(name.trim()))
    if (names.length) {
      return names.join(', ')
    }
  }
  if (event.event_type === 'prompt.sent') {
    const model = typeof event.data?.model_id === 'string' && event.data.model_id.trim()
      ? event.data.model_id
      : dict.event.currentModel
    return `${model} · ${event.data?.native_tool_loop ? dict.event.nativeToolLoop : dict.event.standardChat}`
  }
  if (event.event_type === 'model.turn.started') {
    const turn = agentEventTurn(event)
    if (turn > 0 && status === 'completed') {
      return dict.event.modelTurnFinished(turn)
    }
    return event.message || (turn > 0 ? dict.event.requestingModelTurn(turn) : dict.event.requestingModel)
  }
  if (event.event_type === 'model.reconnecting') {
    const delayMS = typeof event.data?.delay_ms === 'number' ? Math.max(0, event.data.delay_ms) : 0
    const seconds = Math.ceil(delayMS / 1000)
    const delay = seconds > 0 ? dict.event.reconnectingInSeconds(seconds) : dict.event.reconnectingNow
    const reason = typeof event.data?.reason === 'string'
      ? dict.event.reconnectReason[event.data.reason]
      : ''
    return reason ? `${delay} · ${reason}` : delay
  }
  if (event.event_type === 'model.delta') {
    const chars = typeof event.data?.chars === 'number'
      ? event.data.chars
      : Array.from(String(event.data?.preview || '')).length
    return chars ? dict.event.receivedChars(chars) : dict.event.waitingBackendContent
  }
  if (event.event_type === 'model.tool_call.delta' || event.event_type === 'model.tool_call.ready') {
    const args = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
    return compactAgentRunDetail(args || event.message || '', locale)
  }
  if (event.event_type === 'model.turn.completed') {
    const toolCount = typeof event.data?.tool_calls === 'number' ? event.data.tool_calls : 0
    const contentChars = typeof event.data?.content_chars === 'number' ? event.data.content_chars : 0
    if (toolCount > 0) {
      return dict.event.modelRequestedNTools(toolCount)
    }
    if (contentChars > 0) {
      return dict.event.modelReturnedChars(contentChars)
    }
    return event.message || dict.event.thisTurnCompleted
  }
  return compactAgentRunDetail(event.message || event.label || '', locale)
}

export function agentEventTurn(event: AgentEvent) {
  const raw = event.data?.turn
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export function agentReconnectAttempt(event: AgentEvent) {
  const raw = event.data?.attempt
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
}

function agentReconnectMaxRetries(event: AgentEvent) {
  const raw = event.data?.max_retries
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
}

function formatAgentRunLogEventPayload(event: AgentEvent) {
  return {
    type: event.event_type,
    stage: event.stage,
    status: event.status,
    label: event.label,
    message: event.message,
    data: event.data,
    created_at: event.created_at,
  }
}

