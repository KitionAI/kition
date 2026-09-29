/**
 * The per-render input for the Agent turn context: what the user is
 * looking at, as the workspace knows it. Pure so the mapping from tabs and
 * table context to the Agent's view stays testable.
 */
import { buildActiveBrowserTabContext, type buildAgentTurnContext } from '@/features/agent/public'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { deriveAgentPaneContext, resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'
import type { DataDocument, DataTable } from '@/types/dataDocument'

export type WorkspaceAgentTurnUpdateInput = {
  activeWorkspaceTab: WorkspaceTab | null | undefined
  tableAgentContext: { activeDocument: DataDocument | null; activeTable: DataTable | null } | null
  /** The .kitable path the table context belongs to, or ''. */
  tableAgentDocumentPath: string
  docIdByKitablePath: Record<string, string | number | undefined>
  /** Table id resolved from the browser tab's origin, used while a browser tab is active. */
  browserResolvedTableId: number | null
  activeDataWorkspaceTableId: number | null
  browserEnabled: boolean
}

export function buildWorkspaceAgentTurnUpdate({
  activeWorkspaceTab,
  tableAgentContext,
  tableAgentDocumentPath,
  docIdByKitablePath,
  browserResolvedTableId,
  activeDataWorkspaceTableId,
  browserEnabled,
}: WorkspaceAgentTurnUpdateInput): Parameters<typeof buildAgentTurnContext>[0] {
  const activeDocument = resolveAgentActiveDocument(activeWorkspaceTab)
  const activeBrowserTab = activeWorkspaceTab?.type === 'browser' ? activeWorkspaceTab : null
  return {
    activeDocumentPath: activeDocument.path,
    activeDocumentFormat: activeDocument.format,
    activeDocument: tableAgentContext?.activeDocument,
    activeTable: tableAgentContext?.activeTable,
    activeDataDocumentId: Number(tableAgentDocumentPath ? docIdByKitablePath[tableAgentDocumentPath] : 0) || 0,
    activeDataTableId: activeBrowserTab ? browserResolvedTableId : activeDataWorkspaceTableId,
    browserContext: activeBrowserTab
      ? buildActiveBrowserTabContext({
          provider: activeBrowserTab.provider,
          host: activeBrowserTab.host,
          url: activeBrowserTab.url,
          title: activeBrowserTab.title,
        })
      : undefined,
    browserEnabled,
    // Same mapping as the chat panel's empty-state copy, so the system
    // prompt addendum matches what the user sees.
    paneContext: deriveAgentPaneContext(activeWorkspaceTab),
    // A workflow tab opened on one workflow lets the runtime attach that
    // workflow's summary; the global list carries no id.
    activeWorkflowId: activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.workflowId : undefined,
    activeDesignPath: activeWorkspaceTab?.type === 'design' ? activeWorkspaceTab.path : undefined,
  }
}
