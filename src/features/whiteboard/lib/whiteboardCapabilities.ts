import { AGENT_WHITEBOARD_CAPABILITY } from '@/types/whiteboardAgent'

export function runtimeSupportsWhiteboard(
  capabilities?: readonly string[],
): boolean {
  return Boolean(capabilities?.includes(AGENT_WHITEBOARD_CAPABILITY))
}
