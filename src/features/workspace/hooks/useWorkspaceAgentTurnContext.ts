import { useCallback, useRef, useState } from 'react'

import type { AgentBrowserContext } from '@/api/agent'
import {
  buildAgentTurnContext,
  finalizeAgentTurnContext,
  mapBrowserPageContextToAgentBrowserContext,
  type AgentTurnContext,
} from '@/features/agent/public'
import { loadMarkdownImageInsertionResolver, type MarkdownImageInsertionSnapshot } from '@/features/document/public'
import type { WorkspaceBrowserTab } from '@/features/workspace/hooks/useWorkspaceBrowserPanel'
import { extractBrowserPageContext } from '@/services/desktop'
import type { AgentWhiteboardContext } from '@/types/whiteboardAgent'

type BuildTurnContextInput = Parameters<typeof buildAgentTurnContext>[0]
type PreflightBrowserContext = (content: string) => Promise<AgentBrowserContext | undefined>

const INITIAL_TURN_CONTEXT: AgentTurnContext = {
  activeDocumentPath: '',
  activeDataDocumentId: 0,
  activeDataTableId: 0,
  taskMode: 'auto',
  browserEnabled: false,
}

type UseWorkspaceAgentTurnContextOptions = {
  /** Context for the active whiteboard, or undefined when no board is active. */
  buildWhiteboardContext: () => AgentWhiteboardContext | undefined
}

/**
 * The context attached to every Agent turn: what the user is looking at
 * (document, table, board, browser tab), whether the browser is enabled for
 * the Agent, and the cursor-aware image insertion anchor. The workspace
 * screen refreshes the base context during render; `getTurnContext`
 * finalizes it at send time and enriches it with the live browser page.
 */
export function useWorkspaceAgentTurnContext({ buildWhiteboardContext }: UseWorkspaceAgentTurnContextOptions) {
  const turnContextRef = useRef<AgentTurnContext>(INITIAL_TURN_CONTEXT)
  const insertionSnapshotRef = useRef<MarkdownImageInsertionSnapshot | null>(null)
  const activeBrowserTabRef = useRef<WorkspaceBrowserTab | null>(null)
  const preflightRef = useRef<PreflightBrowserContext>(async () => undefined)
  const [browserEnabled, setBrowserEnabledState] = useState(false)

  /** Called during render with the current tab state; cheap and idempotent. */
  const updateTurnContext = useCallback((input: BuildTurnContextInput) => {
    turnContextRef.current = buildAgentTurnContext(input)
  }, [])

  const setActiveBrowserTab = useCallback((tab: WorkspaceBrowserTab | null) => {
    activeBrowserTabRef.current = tab
  }, [])

  const getTaskMode = useCallback(() => turnContextRef.current.taskMode, [])

  const setBrowserEnabled = useCallback((next: boolean) => {
    setBrowserEnabledState(next)
    turnContextRef.current = { ...turnContextRef.current, browserEnabled: next }
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

  /** The preflight is provided later by the browser automation; this indirection keeps the Agent hook's props stable. */
  const setPreflight = useCallback((preflight: PreflightBrowserContext) => {
    preflightRef.current = preflight
  }, [])
  const prepareBrowserContextForTurn = useCallback(
    (content: string) => preflightRef.current(content),
    [],
  )

  const getTurnContext = useCallback(async (): Promise<AgentTurnContext> => {
    // The insertion resolver carries the Markdown parser; load it with the
    // editor chunk instead of at startup.
    const resolveMarkdownImageInsertionContext = await loadMarkdownImageInsertionResolver()
    const base = finalizeAgentTurnContext({
      baseContext: turnContextRef.current,
      markdownImageInsertionSnapshot: insertionSnapshotRef.current,
      resolveMarkdownImageInsertionContext,
    })
    const whiteboardContext = base.paneContext === 'whiteboard' ? buildWhiteboardContext() : undefined
    const scopedBase = { ...base, whiteboardContext }
    const tab = activeBrowserTabRef.current
    if (!tab) return scopedBase
    try {
      const pageContext = await extractBrowserPageContext({ provider: tab.provider })
      const enriched = mapBrowserPageContextToAgentBrowserContext(pageContext, tab.provider)
      if (enriched) return { ...scopedBase, browserContext: enriched }
    } catch {
      // The embedded browser may be unavailable (for example a web build);
      // fall back to the thin tab metadata already in the base context.
    }
    return scopedBase
  }, [buildWhiteboardContext])

  return {
    turnContextRef,
    updateTurnContext,
    setActiveBrowserTab,
    getTaskMode,
    browserEnabled,
    setBrowserEnabled,
    handleInsertionContextChange,
    setPreflight,
    prepareBrowserContextForTurn,
    getTurnContext,
  }
}
