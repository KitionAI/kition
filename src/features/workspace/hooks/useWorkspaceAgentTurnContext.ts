import { useCallback, useRef } from 'react'

import { buildAgentTurnContext, type AgentTurnContext } from '@/features/agent/public'

type BuildTurnContextInput = Parameters<typeof buildAgentTurnContext>[0]

const INITIAL_TURN_CONTEXT: AgentTurnContext = {
  activeDocumentPath: '',
  taskMode: 'auto',
}

/**
 * The context attached to every Agent turn: what the user is looking at
 * (document, workflow). The workspace screen refreshes it during render;
 * `getTurnContext` reads it at send time.
 */
export function useWorkspaceAgentTurnContext() {
  const turnContextRef = useRef<AgentTurnContext>(INITIAL_TURN_CONTEXT)

  /** Called during render with the current tab state; cheap and idempotent. */
  const updateTurnContext = useCallback((input: BuildTurnContextInput) => {
    turnContextRef.current = buildAgentTurnContext(input)
  }, [])

  const getTurnContext = useCallback(async (): Promise<AgentTurnContext> => turnContextRef.current, [])

  return {
    turnContextRef,
    updateTurnContext,
    getTurnContext,
  }
}
