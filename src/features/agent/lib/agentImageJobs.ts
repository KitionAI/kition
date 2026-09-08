import type { AgentArtifact, AgentMessage, AgentStreamEvent } from '@/api/agent'
import type { AgentImageArtifact, AgentImageGenerationEvent } from '@/types/imageGeneration'
import { readAgentImageGenerationEvent } from './agentImageGenerationStream'

export type AgentImageSessionEvent = AgentImageGenerationEvent & {
  clientTurnCreatedAt?: string
  clientMessageId?: number
}

export function readAgentImageGenerationSessionEvent(frame: AgentStreamEvent, turnCreatedAt?: string, messageId?: number) {
  const event = readAgentImageGenerationEvent(frame)
  if (!event) return null
  return {
    ...event,
    clientTurnCreatedAt: turnCreatedAt || frame.event?.created_at,
    clientMessageId: messageId || frame.event?.message_id,
  }
}

export function imageEventsForTurn(
  events: AgentImageSessionEvent[],
  message: AgentMessage | undefined,
  nextTurnCreatedAt: string | null,
  isActiveTurn: boolean,
) {
  return events.filter((event) => {
    if (event.clientMessageId && event.clientMessageId > 0) return event.clientMessageId === message?.id
    if (!event.clientTurnCreatedAt) return isActiveTurn
    return (!message || event.clientTurnCreatedAt >= message.created_at)
      && (!nextTurnCreatedAt || event.clientTurnCreatedAt < nextTurnCreatedAt)
  })
}

export function buildAgentImageJobs(events: AgentImageSessionEvent[]) {
  const jobs = new Map<string, {
    requestId: string
    latest: AgentImageGenerationEvent
    artifacts: AgentImageArtifact[]
  }>()
  for (const event of events) {
    const job = jobs.get(event.request_id) || {
      requestId: event.request_id,
      latest: event,
      artifacts: [],
    }
    const terminal = ['completed', 'failed', 'canceled'].includes(job.latest.status)
    if (!terminal || ['completed', 'failed', 'canceled'].includes(event.status)) job.latest = event
    if (event.artifact) {
      const index = job.artifacts.findIndex((artifact) => artifact.id === event.artifact?.id)
      if (index < 0) job.artifacts.push(event.artifact)
      else job.artifacts[index] = event.artifact
    }
    jobs.set(event.request_id, job)
  }
  return [...jobs.values()].map((job) => ({
    ...job,
    artifacts: job.artifacts.sort((a, b) => a.variant_index - b.variant_index),
  }))
}

export function agentArtifactFromImageEvent(event: AgentImageGenerationEvent | null, sessionId: number): AgentArtifact | undefined {
  if (!event?.artifact) return undefined
  return { ...event.artifact, session_id: sessionId, user_id: 0, kind: 'image' }
}
