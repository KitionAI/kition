import { useCallback, useRef } from 'react'

import { buildAgentTurnContext, type AgentTurnContext } from '@/features/agent/public'
import type { AgentDesignContext } from '@/types/designAgent'

type BuildTurnContextInput = Parameters<typeof buildAgentTurnContext>[0]

const INITIAL_TURN_CONTEXT: AgentTurnContext = {
  activeDocumentPath: '',
  taskMode: 'auto',
}

type UseWorkspaceAgentTurnContextOptions = {
  /** Context for the active design, or undefined when no design is active. */
  buildDesignContext: () => AgentDesignContext | undefined
}

/**
 * The context attached to every Agent turn: what the user is looking at
 * (document, workflow, design). The workspace screen refreshes the base context during render;
 * `getTurnContext` finalizes it at send time.
 */
export function useWorkspaceAgentTurnContext({ buildDesignContext }: UseWorkspaceAgentTurnContextOptions) {
  const turnContextRef = useRef<AgentTurnContext>(INITIAL_TURN_CONTEXT)

  /** Called during render with the current tab state; cheap and idempotent. */
  const updateTurnContext = useCallback((input: BuildTurnContextInput) => {
    turnContextRef.current = buildAgentTurnContext(input)
  }, [])

  const getTurnContext = useCallback(async (): Promise<AgentTurnContext> => {
    const base = turnContextRef.current
    const designContext = base.paneContext === 'design' ? buildDesignContext() : undefined
    return { ...base, designContext }
  }, [buildDesignContext])

  return {
    turnContextRef,
    updateTurnContext,
    getTurnContext,
  }
}
