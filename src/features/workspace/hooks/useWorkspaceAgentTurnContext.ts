import { useCallback, useRef } from 'react'

import {
  buildAgentTurnContext,
  finalizeAgentTurnContext,
  type AgentTurnContext,
} from '@/features/agent/public'
import { loadMarkdownImageInsertionResolver, type MarkdownImageInsertionSnapshot } from '@/features/document/public'
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
 * (document, workflow, design) and the cursor-aware image insertion
 * anchor. The workspace screen refreshes the base context during render;
 * `getTurnContext` finalizes it at send time.
 */
export function useWorkspaceAgentTurnContext({ buildDesignContext }: UseWorkspaceAgentTurnContextOptions) {
  const turnContextRef = useRef<AgentTurnContext>(INITIAL_TURN_CONTEXT)
  const insertionSnapshotRef = useRef<MarkdownImageInsertionSnapshot | null>(null)

  /** Called during render with the current tab state; cheap and idempotent. */
  const updateTurnContext = useCallback((input: BuildTurnContextInput) => {
    turnContextRef.current = buildAgentTurnContext(input)
  }, [])

  /** Document editors publish (and clear) the safe image insertion anchor for their path. */
  const handleInsertionContextChange = useCallback((
    documentPath: string,
    context: MarkdownImageInsertionSnapshot | null,
  ) => {
    if (context) {
      insertionSnapshotRef.current = context
    } else if (insertionSnapshotRef.current?.documentPath === documentPath) {
      insertionSnapshotRef.current = null
    }
  }, [])

  const getTurnContext = useCallback(async (): Promise<AgentTurnContext> => {
    // The insertion resolver carries the Markdown parser; load it with the
    // editor chunk instead of at startup.
    const resolveMarkdownImageInsertionContext = await loadMarkdownImageInsertionResolver()
    const base = finalizeAgentTurnContext({
      baseContext: turnContextRef.current,
      markdownImageInsertionSnapshot: insertionSnapshotRef.current,
      resolveMarkdownImageInsertionContext,
    })
    const designContext = base.paneContext === 'design' ? buildDesignContext() : undefined
    return { ...base, designContext }
  }, [buildDesignContext])

  return {
    turnContextRef,
    updateTurnContext,
    handleInsertionContextChange,
    getTurnContext,
  }
}
