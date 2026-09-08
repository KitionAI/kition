import type { AgentStreamEvent } from '@/api/agent'
import {
  AGENT_IMAGE_GENERATION_EVENT_NAMES,
  AGENT_IMAGE_GENERATION_STATUSES,
  type AgentImageGenerationEvent,
  type AgentImageGenerationEventName,
  type AgentImageGenerationStatus,
} from '@/types/imageGeneration'

export function readAgentImageGenerationEvent(
  event: AgentStreamEvent,
): AgentImageGenerationEvent | null {
  const candidates = [
    event.image_generation,
    event.extra_data?.image_generation,
    event.event?.data?.image_generation,
    event.type === 'image_generation' || event.type === 'image_generation_event'
      ? event.extra_data
      : undefined,
    event.event?.event_type.startsWith('image_generation.')
      ? event.event.data
      : undefined,
  ]
  const value = candidates.find(isAgentImageGenerationEvent)
  return value as AgentImageGenerationEvent | undefined || null
}

export function mergeAgentImageGenerationEvents<T extends AgentImageGenerationEvent>(
  current: readonly T[],
  incoming: T,
) {
  const matchingIndex = current.findIndex((item) => (
    item.request_id === incoming.request_id
    && (
      incoming.event === 'image_generation.artifact'
        ? item.event === incoming.event && item.artifact?.id === incoming.artifact?.id
        : item.event === incoming.event
    )
  ))
  if (matchingIndex < 0) return [...current, incoming]
  return current.map((item, index) => index === matchingIndex ? incoming : item)
}

function isAgentImageGenerationEvent(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<AgentImageGenerationEvent>
  if (!(event.type === 'image_generation.event'
    && event.schema_version === 1
    && typeof event.request_id === 'string'
    && event.request_id.trim().length > 0
    && typeof event.event === 'string'
    && AGENT_IMAGE_GENERATION_EVENT_NAMES.includes(event.event as AgentImageGenerationEventName)
    && typeof event.status === 'string'
    && AGENT_IMAGE_GENERATION_STATUSES.includes(event.status as AgentImageGenerationStatus))) {
    return false
  }
  if (event.event === 'image_generation.progress') {
    return typeof event.progress === 'number'
      && Number.isFinite(event.progress)
      && event.progress >= 0
      && event.progress <= 1
  }
  if (event.event === 'image_generation.artifact') {
    return isAgentImageArtifact(event.artifact, event.request_id)
  }
  if (event.event === 'image_generation.failed') {
    return Boolean(
      event.error
      && typeof event.error.code === 'string'
      && typeof event.error.message === 'string'
      && typeof event.error.retryable === 'boolean',
    )
  }
  return true
}

function isAgentImageArtifact(
  value: unknown,
  requestId: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const artifact = value as AgentImageGenerationEvent['artifact']
  return typeof artifact?.id === 'number'
    && artifact.id > 0
    && typeof artifact.path === 'string'
    && artifact.path.trim().length > 0
    && typeof artifact.mime_type === 'string'
    && artifact.mime_type.startsWith('image/')
    && artifact.provenance?.request_id === requestId
}
