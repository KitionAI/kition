import type { AgentPaneContext, AgentTaskMode } from '@/api/agent'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import type { AgentDesignContext } from '@/types/designAgent'

export type AgentTurnContext = {
  activeDocumentPath: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  taskMode?: AgentTaskMode
  /** Active workbench tab type — forwarded to streamAgentMessage so
   *  the backend can pick a pane-specific system-prompt addendum. */
  paneContext?: AgentPaneContext
  /** Workflow id when paneContext === 'workflow'. Drives the backend's
   *  active-workflow context block. */
  activeWorkflowId?: string
  /** Bounded artboard and layer context for Design turns. */
  designContext?: AgentDesignContext
  /** Workspace path of the active design, for image placement targets. */
  activeDesignPath?: string
}

export function buildAgentTurnContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  paneContext?: AgentPaneContext
  activeWorkflowId?: string
  /** Artboard and layer context for Design turns. */
  designContext?: AgentDesignContext
  activeDesignPath?: string
}): AgentTurnContext {
  const activeDocumentPath = String(input.activeDocumentPath || '').trim()
  return {
    activeDocumentPath,
    activeDocumentFormat: input.activeDocumentFormat,
    paneContext: input.paneContext,
    activeWorkflowId: input.activeWorkflowId,
    designContext: input.designContext,
    activeDesignPath: input.activeDesignPath,
    taskMode: 'auto',
  }
}
