import type { AgentPaneContext, AgentTaskMode } from '@/api/agent'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

export type AgentTurnContext = {
  activeDocumentPath: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  taskMode?: AgentTaskMode
  /** Active workbench tab type — forwarded to streamAgentMessage so
   *  the backend can pick a pane-specific system-prompt addendum. */
  paneContext?: AgentPaneContext
}

export function buildAgentTurnContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  paneContext?: AgentPaneContext
}): AgentTurnContext {
  const activeDocumentPath = String(input.activeDocumentPath || '').trim()
  return {
    activeDocumentPath,
    activeDocumentFormat: input.activeDocumentFormat,
    paneContext: input.paneContext,
    taskMode: 'auto',
  }
}
