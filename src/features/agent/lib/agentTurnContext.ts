import type { AgentPaneContext, AgentTaskMode } from '@/api/agent'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

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
}

export function buildAgentTurnContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  paneContext?: AgentPaneContext
  activeWorkflowId?: string
}): AgentTurnContext {
  const activeDocumentPath = String(input.activeDocumentPath || '').trim()
  return {
    activeDocumentPath,
    activeDocumentFormat: input.activeDocumentFormat,
    paneContext: input.paneContext,
    activeWorkflowId: input.activeWorkflowId,
    taskMode: 'auto',
  }
}
