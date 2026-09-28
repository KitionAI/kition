/**
 * Sending from the Agent composer: a draft that names a local folder first
 * asks for read access to it, and the chosen folder is attached to the
 * session before the message goes out.
 */
import { useCallback } from 'react'

import type { AgentLocalSource, AgentSession } from '@/api/agent'
import { appendAgentLocalSource, extractAgentLocalPathReference } from '@/features/agent/public'
import { chooseAgentAnalysisDirectory } from '@/services/desktop'
import type { AgentImageGenerationIntent } from '@/types/imageGeneration'

type UseWorkspaceAgentComposerOptions = {
  activeSession: AgentSession | null
  agentDrafts: Record<number, string>
  agentLocalSources: Record<number, AgentLocalSource[]>
  addAgentLocalSource: (sessionId: number, source: AgentLocalSource) => void
  sendAiComposerMessage: (sessionId: number, localSources?: AgentLocalSource[], imageIntent?: AgentImageGenerationIntent) => void
  setError: (message: string) => void
}

export function useWorkspaceAgentComposer({
  activeSession,
  agentDrafts,
  agentLocalSources,
  addAgentLocalSource,
  sendAiComposerMessage,
  setError,
}: UseWorkspaceAgentComposerOptions) {
  const addLocalAnalysisSource = useCallback(async (suggestedPath = '') => {
    if (!activeSession) return null
    try {
      const source = await chooseAgentAnalysisDirectory(suggestedPath)
      if (source) addAgentLocalSource(activeSession.id, source)
      return source
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to select an analysis folder')
      return null
    }
  }, [activeSession, addAgentLocalSource, setError])

  const sendMessage = useCallback(async (sessionId: number, imageIntent?: AgentImageGenerationIntent) => {
    const sources = agentLocalSources[sessionId] || []
    const pathReference = extractAgentLocalPathReference(agentDrafts[sessionId] || '')
    if (!sources.length && pathReference) {
      const source = await addLocalAnalysisSource(pathReference)
      if (!source) return
      sendAiComposerMessage(sessionId, appendAgentLocalSource(sources, source), imageIntent)
      return
    }
    sendAiComposerMessage(sessionId, undefined, imageIntent)
  }, [addLocalAnalysisSource, agentDrafts, agentLocalSources, sendAiComposerMessage])

  return { addLocalAnalysisSource, sendMessage }
}
