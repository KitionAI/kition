import type { AgentStreamEvent } from '@/api/agent'
import type { AgentDesignPatch } from '@/types/designAgent'

export const AGENT_DESIGN_PATCH_TOOL = 'design_propose_patch'

export type AgentDesignPatchFrame = {
  designPath: string
  patch: AgentDesignPatch
  provisional: boolean
}

/**
 * Finds a design patch in a stream event, whichever envelope the runtime
 * used: a top-level `design_patch`, the completed `design_propose_patch`
 * tool output, the model's tool arguments while streaming, or a typed
 * `design.patch` event.
 */
export function readAgentDesignPatchFrame(event: AgentStreamEvent): AgentDesignPatchFrame | null {
  const completed = readCompletedToolOutput(event)
  const modelArguments = readModelToolArguments(event)
  const candidates = [
    event.design_patch,
    event.extra_data?.design_patch,
    completed?.patch,
    modelArguments,
    event.type === 'design_patch' || event.type === 'design.patch' ? event.extra_data?.patch : undefined,
    event.event?.event_type === 'design.patch'
      ? event.event.data?.design_patch || event.event.data?.patch || event.event.data
      : undefined,
  ]
  const patch = candidates.find(isDesignPatchLike)
  if (!patch) return null
  return {
    designPath: firstPath(
      event.design_path,
      event.extra_data?.design_path,
      completed?.designPath,
      event.event?.data?.design_path,
    ),
    patch: patch as AgentDesignPatch,
    provisional:
      event.provisional === true
      || event.extra_data?.provisional === true
      || event.event?.status === 'running'
      || Boolean(modelArguments)
      || event.type.includes('delta')
      || event.type.includes('provisional'),
  }
}

function readCompletedToolOutput(event: AgentStreamEvent) {
  if (
    event.type !== 'tool_call'
    || event.tool_call?.tool_name !== AGENT_DESIGN_PATCH_TOOL
    || event.tool_call.status !== 'completed'
  ) {
    return undefined
  }
  const output = readJSONValue(event.tool_call.output_data)
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  return { designPath: record.design_path, patch: readJSONValue(record.design_patch) }
}

function readModelToolArguments(event: AgentStreamEvent) {
  if (
    event.type !== 'model_tool_call_ready'
    || event.extra_data?.tool_name !== AGENT_DESIGN_PATCH_TOOL
    || typeof event.extra_data?.arguments !== 'string'
  ) {
    return undefined
  }
  return readJSONValue(event.extra_data.arguments)
}

function readJSONValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function firstPath(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function isDesignPatchLike(value: unknown) {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'design.patch')
}
