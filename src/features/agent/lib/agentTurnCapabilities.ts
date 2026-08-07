import type {
  AgentEvent,
  AgentTurnCapabilities,
} from '@/api/agent'
import type { AgentModelOption } from '@/features/agent/lib/agentConfig'

export type AgentHostedWebSearchState = {
  available: boolean
  reason: string
  source: 'runtime' | 'model'
}

export function readLatestAgentTurnCapabilities(
  events: AgentEvent[],
  modelId?: string,
): AgentTurnCapabilities | undefined {
  const expectedModelId = String(modelId || '').trim()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.event_type !== 'prompt.sent') {
      continue
    }
    const eventModelId = typeof event.data?.model_id === 'string'
      ? event.data.model_id.trim()
      : ''
    if (expectedModelId && eventModelId && eventModelId !== expectedModelId) {
      continue
    }
    const capabilities = event.data?.turn_capabilities
    if (capabilities && Array.isArray(capabilities.available_tools)) {
      return capabilities
    }
  }
  return undefined
}

export function modelSupportsHostedWebSearch(
  option: AgentModelOption | null | undefined,
) {
  const model = option?.runtimeModel
  if (!model) {
    return false
  }

  const provider = model.provider_type.toLowerCase()
  const wireAPI = String(model.wire_api || '').toLowerCase()
  const modelName = model.model_name.toLowerCase()

  if (wireAPI === 'responses') {
    return ['openai', 'custom', 'kition_console'].includes(provider)
      || modelName.includes('gpt')
  }
  if (wireAPI === 'anthropic_messages') {
    return ['anthropic', 'custom'].includes(provider)
      || modelName.includes('claude')
  }
  return false
}

export function resolveAgentHostedWebSearchState(input: {
  capabilities?: AgentTurnCapabilities
  model?: AgentModelOption | null
}): AgentHostedWebSearchState {
  if (input.capabilities) {
    return {
      available: input.capabilities.hosted_web_search.available,
      reason: input.capabilities.hosted_web_search.reason,
      source: 'runtime',
    }
  }

  const available = modelSupportsHostedWebSearch(input.model)
  return {
    available,
    reason: available ? 'model_supported' : 'provider_unsupported',
    source: 'model',
  }
}
