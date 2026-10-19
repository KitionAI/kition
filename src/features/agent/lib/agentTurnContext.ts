import type { AgentPaneContext, AgentTaskMode } from '@/api/agent'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import type { DataDocument, DataTable } from '@kition/table-editor'
import type { AgentWhiteboardContext } from '@kition/board-editor'
import type { AgentDesignContext } from '@/types/designAgent'
import type { MarkdownImageInsertionContext, MarkdownImageInsertionSnapshot } from '@/features/document/public'

export type AgentTurnContext = {
  activeDocumentPath: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDataDocumentId: number
  activeDataTableId: number
  taskMode?: AgentTaskMode
  /** Active workbench tab type — forwarded to streamAgentMessage so
   *  the backend can pick a pane-specific system-prompt addendum. */
  paneContext?: AgentPaneContext
  /** Workflow id when paneContext === 'workflow'. Drives the backend's
   *  active-workflow context block. */
  activeWorkflowId?: string
  /** Compact selection, viewport, or board context for AI Whiteboard turns. */
  whiteboardContext?: AgentWhiteboardContext
  /** Bounded artboard and layer context for Design turns. */
  designContext?: AgentDesignContext
  /** Workspace path of the active design, for image placement targets. */
  activeDesignPath?: string
  markdownImageInsertionContext?: MarkdownImageInsertionContext
}

/**
 * Attaches the image insertion anchor to the base context when the editor's
 * snapshot is for the active document. The resolver is injected: it needs
 * the Markdown parser, which the caller loads with the editor so the parser
 * stays out of the startup bundle.
 */
export function finalizeAgentTurnContext(input: {
  baseContext: AgentTurnContext
  markdownImageInsertionSnapshot?: MarkdownImageInsertionSnapshot | null
  resolveMarkdownImageInsertionContext: (snapshot: MarkdownImageInsertionSnapshot) => MarkdownImageInsertionContext
}): AgentTurnContext {
  const snapshot = input.markdownImageInsertionSnapshot
  const markdownImageInsertionContext = snapshot?.documentPath === input.baseContext.activeDocumentPath
    ? input.resolveMarkdownImageInsertionContext(snapshot)
    : undefined
  return {
    ...input.baseContext,
    markdownImageInsertionContext,
  }
}

export function buildAgentTurnContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDocument?: DataDocument | null
  activeTable?: DataTable | null
  activeDataDocumentId?: number | null
  activeDataTableId?: number | null
  paneContext?: AgentPaneContext
  activeWorkflowId?: string
  whiteboardContext?: AgentWhiteboardContext
  /** Artboard and layer context for Design turns. */
  designContext?: AgentDesignContext
  activeDesignPath?: string
  markdownImageInsertionContext?: MarkdownImageInsertionContext | null
}): AgentTurnContext {
  const activeDocumentPath = String(input.activeDocumentPath || '').trim()
  const markdownImageInsertionContext = input.markdownImageInsertionContext?.documentPath === activeDocumentPath
    ? input.markdownImageInsertionContext
    : undefined
  return {
    activeDocumentPath,
    activeDocumentFormat: input.activeDocumentFormat,
    activeDataDocumentId: input.activeDocument?.id ?? input.activeDataDocumentId ?? 0,
    activeDataTableId: input.activeTable?.id ?? input.activeDataTableId ?? 0,
    paneContext: input.paneContext,
    activeWorkflowId: input.activeWorkflowId,
    whiteboardContext: input.whiteboardContext,
    designContext: input.designContext,
    activeDesignPath: input.activeDesignPath,
    markdownImageInsertionContext,
    taskMode: 'auto',
  }
}
