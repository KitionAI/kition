import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentArtifact, AgentToolCall } from '@/api/agent'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import {
  buildWhiteboardImageAgentInstruction,
  getGeneratedImageToolOutputPaths,
  isGeneratedImageArtifact,
  type WhiteboardImageGenerationRequest,
  type WhiteboardImageGenerationStartResult,
} from '@/features/whiteboard/lib/whiteboardImageGeneration'

type PendingWhiteboardImageGeneration = {
  boardPath: string
  deliveredPaths: Set<string>
  knownArtifactIds: Set<number>
  knownToolCallIds: Set<number>
  observedBusy: boolean
  requestId: string
  timeoutId: number
}

export function useWhiteboardImageGeneration({
  activeSessionId,
  agentArtifacts,
  agentBusySessions,
  agentToolCalls,
  available,
  bridgesRef,
  createAgentChat,
  modelAvailable,
  sendAgentAction,
  setActiveSessionId,
}: {
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
  const { t } = useTranslation('imageGeneration')
  const pendingRef = useRef(new Map<number, PendingWhiteboardImageGeneration>())

  const startImageGeneration = useCallback(async (
    request: WhiteboardImageGenerationRequest,
  ): Promise<WhiteboardImageGenerationStartResult> => {
    if (!available || !modelAvailable) {
      return { accepted: false, error: t('errors.unavailable') }
    }

    let sessionId = activeSessionId
    if (
      !sessionId
      || agentBusySessions.has(sessionId)
      || pendingRef.current.has(sessionId)
    ) {
      const session = await createAgentChat({ focusTab: false })
      sessionId = session?.id ?? null
    }
    if (!sessionId) {
      return { accepted: false, error: t('errors.startFailed') }
    }

    setActiveSessionId(sessionId)
    const knownArtifactIds = new Set(
      (agentArtifacts[sessionId] || []).map((artifact) => artifact.id),
    )
    const knownToolCallIds = new Set(
      (agentToolCalls[sessionId] || []).map((toolCall) => toolCall.id),
    )
    const timeoutId = window.setTimeout(() => {
      const pending = pendingRef.current.get(sessionId)
      if (!pending || pending.requestId !== request.requestId) return
      bridgesRef.current[pending.boardPath]?.completeImageGeneration?.({
        error: t('errors.timeout'),
        requestId: pending.requestId,
      })
      pendingRef.current.delete(sessionId)
    }, 120_000)
    pendingRef.current.set(sessionId, {
      boardPath: request.boardPath,
      deliveredPaths: new Set(),
      knownArtifactIds,
      knownToolCallIds,
      observedBusy: false,
      requestId: request.requestId,
      timeoutId,
    })
    sendAgentAction(sessionId, {
      content: buildWhiteboardImageAgentInstruction(request),
    })
    return { accepted: true }
  }, [
    activeSessionId,
    agentArtifacts,
    agentBusySessions,
    agentToolCalls,
    available,
    bridgesRef,
    createAgentChat,
    modelAvailable,
    sendAgentAction,
    setActiveSessionId,
    t,
  ])

  useEffect(() => {
    for (const [sessionId, pending] of pendingRef.current) {
      const busy = agentBusySessions.has(sessionId)
      if (busy) pending.observedBusy = true
      const artifactPaths = (agentArtifacts[sessionId] || []).filter((artifact) => (
        !pending.knownArtifactIds.has(artifact.id)
          && isGeneratedImageArtifact(artifact)
      )).map((artifact) => artifact.path)
      const toolOutputPaths = (agentToolCalls[sessionId] || [])
        .filter((toolCall) => !pending.knownToolCallIds.has(toolCall.id))
        .flatMap(getGeneratedImageToolOutputPaths)
      const paths = Array.from(new Set([...artifactPaths, ...toolOutputPaths]))
        .filter((path) => !pending.deliveredPaths.has(path))
      if (paths.length) {
        paths.forEach((path) => pending.deliveredPaths.add(path))
        bridgesRef.current[pending.boardPath]?.receiveImageGenerationArtifacts?.({
          paths,
          requestId: pending.requestId,
        })
      }
      if (!busy && (pending.observedBusy || pending.deliveredPaths.size > 0)) {
        window.clearTimeout(pending.timeoutId)
        bridgesRef.current[pending.boardPath]?.completeImageGeneration?.({
          error: pending.deliveredPaths.size ? undefined : t('errors.noResult'),
          requestId: pending.requestId,
        })
        pendingRef.current.delete(sessionId)
      }
    }
  }, [agentArtifacts, agentBusySessions, agentToolCalls, bridgesRef, t])

  useEffect(() => () => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeoutId)
    }
    pendingRef.current.clear()
  }, [])

  return startImageGeneration
}
