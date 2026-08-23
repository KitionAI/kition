import type { AgentStreamEvent } from '@/api/agent'
import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

export type AgentWhiteboardPatchFrame = {
  patch: AgentWhiteboardPatch
  provisional: boolean
}

export function readAgentWhiteboardPatchFrame(
  event: AgentStreamEvent,
): AgentWhiteboardPatchFrame | null {
  const candidates = [
    event.whiteboard_patch,
    event.extra_data?.whiteboard_patch,
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
    patch: patch as AgentWhiteboardPatch,
    provisional: event.provisional === true
      || event.extra_data?.provisional === true
      || event.event?.status === 'running'
      || event.type.includes('delta')
      || event.type.includes('provisional'),
  }
}

function isWhiteboardPatchLike(value: unknown) {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { type?: unknown }).type === 'whiteboard.patch',
  )
}
