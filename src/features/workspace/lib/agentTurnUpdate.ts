/**
 * The per-render input for the Agent turn context: what the user is
 * looking at, as the workspace knows it. Pure so the mapping from tabs and
 * table context to the Agent's view stays testable.
 */
import type { buildAgentTurnContext } from '@/features/agent/public'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { deriveAgentPaneContext, resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'
import type { DataDocument, DataTable } from '@kition/table-editor'

export type WorkspaceAgentTurnUpdateInput = {
  activeWorkspaceTab: WorkspaceTab | null | undefined
  tableAgentContext: { activeDocument: DataDocument | null; activeTable: DataTable | null } | null
  /** The .kitable path the table context belongs to, or ''. */
  tableAgentDocumentPath: string
  docIdByKitablePath: Record<string, string | number | undefined>
  activeDataWorkspaceTableId: number | null
}

export function buildWorkspaceAgentTurnUpdate({
  activeWorkspaceTab,
  tableAgentContext,
  tableAgentDocumentPath,
  docIdByKitablePath,
  activeDataWorkspaceTableId,
}: WorkspaceAgentTurnUpdateInput): Parameters<typeof buildAgentTurnContext>[0] {
  const activeDocument = resolveAgentActiveDocument(activeWorkspaceTab)
  return {
    activeDocumentPath: activeDocument.path,
    activeDocumentFormat: activeDocument.format,
    activeDocument: tableAgentContext?.activeDocument,
    activeTable: tableAgentContext?.activeTable,
    activeDataDocumentId: Number(tableAgentDocumentPath ? docIdByKitablePath[tableAgentDocumentPath] : 0) || 0,
    activeDataTableId: activeDataWorkspaceTableId,
    // Same mapping as the chat panel's empty-state copy, so the system
    // prompt addendum matches what the user sees.
    paneContext: deriveAgentPaneContext(activeWorkspaceTab),
    // A workflow tab opened on one workflow lets the runtime attach that
    // workflow's summary; the global list carries no id.
    activeWorkflowId: activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.workflowId : undefined,
    activeDesignPath: activeWorkspaceTab?.type === 'design' ? activeWorkspaceTab.path : undefined,
  }
}
