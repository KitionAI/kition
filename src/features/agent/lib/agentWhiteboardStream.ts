import type { AgentStreamEvent } from '@/api/agent'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

export type AgentWhiteboardPatchFrame = {
  boardPath: string
  patch: AgentWhiteboardPatch
  provisional: boolean
}

export function readAgentWhiteboardPatchFrame(
  event: AgentStreamEvent,
): AgentWhiteboardPatchFrame | null {
  const completedToolOutput = readCompletedWhiteboardToolOutput(event)
  const modelToolPatch = readWhiteboardModelToolArguments(event)
  const candidates = [
    event.whiteboard_patch,
    event.extra_data?.whiteboard_patch,
    completedToolOutput?.whiteboardPatch,
    modelToolPatch,
    event.type === 'whiteboard_patch' || event.type === 'whiteboard.patch'
      ? event.extra_data?.patch
      : undefined,
    event.event?.event_type === 'whiteboard.patch'
      ? event.event.data?.whiteboard_patch || event.event.data?.patch || event.event.data
      : undefined,
  ]
  const patch = candidates.find(isWhiteboardPatchLike)
  if (!patch) return null

  return {
    boardPath: firstWhiteboardBoardPath(
      event.board_path,
      event.extra_data?.board_path,
      completedToolOutput?.boardPath,
      event.event?.data?.board_path,
    ),
    patch: patch as AgentWhiteboardPatch,
    provisional: event.provisional === true
      || event.extra_data?.provisional === true
      || event.event?.status === 'running'
      || Boolean(modelToolPatch)
      || event.type.includes('delta')
      || event.type.includes('provisional'),
  }
}

function readCompletedWhiteboardToolOutput(event: AgentStreamEvent) {
  if (
    event.type !== 'tool_call'
    || event.tool_call?.tool_name !== 'whiteboard_propose_patch'
    || event.tool_call.status !== 'completed'
  ) {
    return undefined
  }

  const output = readJSONObject(event.tool_call.output_data)
  if (!output) return undefined

  return {
    boardPath: output.board_path,
    whiteboardPatch: readJSONValue(output.whiteboard_patch),
  }
}

function readWhiteboardModelToolArguments(event: AgentStreamEvent) {
  if (
    event.type !== 'model_tool_call_ready'
    || event.extra_data?.tool_name !== 'whiteboard_propose_patch'
    || typeof event.extra_data?.arguments !== 'string'
  ) {
    return undefined
  }
  try {
    return JSON.parse(event.extra_data.arguments) as unknown
  } catch {
    return undefined
  }
}

function readJSONObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = readJSONValue(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function readJSONValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function firstWhiteboardBoardPath(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function isWhiteboardPatchLike(value: unknown) {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'whiteboard.patch',
  )
}
