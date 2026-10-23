/**
 * The per-render input for the Agent turn context: what the user is
 * looking at, as the workspace knows it. Pure so the mapping from tabs to
 * the Agent's view stays testable.
 */
import type { buildAgentTurnContext } from '@/features/agent/public'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { deriveAgentPaneContext, resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'

export type WorkspaceAgentTurnUpdateInput = {
  activeWorkspaceTab: WorkspaceTab | null | undefined
}

export function buildWorkspaceAgentTurnUpdate({
  activeWorkspaceTab,
}: WorkspaceAgentTurnUpdateInput): Parameters<typeof buildAgentTurnContext>[0] {
  const activeDocument = resolveAgentActiveDocument(activeWorkspaceTab)
  return {
    activeDocumentPath: activeDocument.path,
    activeDocumentFormat: activeDocument.format,
    // Same mapping as the chat panel's empty-state copy, so the system
    // prompt addendum matches what the user sees.
    paneContext: deriveAgentPaneContext(activeWorkspaceTab),
    // A workflow tab opened on one workflow lets the runtime attach that
    // workflow's summary; the global list carries no id.
    activeWorkflowId: activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.workflowId : undefined,
    activeDesignPath: activeWorkspaceTab?.type === 'design' ? activeWorkspaceTab.path : undefined,
  }
}
