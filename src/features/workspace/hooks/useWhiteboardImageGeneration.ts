import { useCallback } from 'react'

import type { AgentArtifact, AgentToolCall } from '@/api/agent'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import {
  buildWhiteboardImageAgentInstruction,
  type WhiteboardImageGenerationRequest,
  type WhiteboardImageGenerationStartResult,
} from '@/features/whiteboard/lib/whiteboardImageGeneration'
import { useAgentImageGeneration } from './useAgentImageGeneration'

/** Image studio generation for boards: the shared flow keyed by board path. */
export function useWhiteboardImageGeneration(input: {
  activeSessionId: number | null
  agentArtifacts: Record<number, AgentArtifact[]>
  agentBusySessions: ReadonlySet<number>
  agentToolCalls: Record<number, AgentToolCall[]>
  available: boolean
  bridgesRef: { current: Record<string, WhiteboardAgentBridge> }
  createAgentChat: (options?: { focusTab?: boolean }) => Promise<{ id: number } | null>
  modelAvailable: boolean
  sendAgentAction: (sessionId: number, input: { content: string }) => void
  setActiveSessionId: (sessionId: number) => void
}) {
  const start = useAgentImageGeneration<WhiteboardImageGenerationRequest & { targetPath: string }>({
    ...input,
    buildInstruction: buildWhiteboardImageAgentInstruction,
  })
  return useCallback(
    (request: WhiteboardImageGenerationRequest): Promise<WhiteboardImageGenerationStartResult> =>
      start({ ...request, targetPath: request.boardPath }),
    [start],
  )
}
