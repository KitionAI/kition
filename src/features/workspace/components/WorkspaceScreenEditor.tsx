import type { ComponentProps } from 'react'

import type { WorkspaceAgentPanelState } from '@/features/workspace/components/WorkspaceAgentChrome'
import { WorkspaceEditorContent } from '@/features/workspace/components/WorkspaceEditorContent'
import { WorkspaceEditorPane } from '@/features/workspace/components/WorkspaceEditorPane'
import type { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'

export type WorkspaceEditorContentProps = ComponentProps<typeof WorkspaceEditorContent>

/** What the editor column needs, as the bundles the workspace hooks already return. */
export type WorkspaceScreenEditorInput = {
  rootPath: string
  workspaceTabs: WorkspaceEditorContentProps['workspaceTabs']
  activeWorkspaceTab: WorkspaceEditorContentProps['activeWorkspaceTab']
  activeWorkspaceTabId: string
  galleryPanelProps: WorkspaceEditorContentProps['galleryPanelProps']
  agentPanel: Pick<WorkspaceAgentPanelState, 'open' | 'setOpen' | 'setHistoryOpen'>
  templateDialogs: Pick<ReturnType<typeof useWorkspaceTemplateDialogs>, 'openDocumentTemplateDialog'>
  workflows: {
    /** The workflows of one table file. */
    openTableFileWorkflow: (tablePath: string, workflowId?: string) => void
    openWorkspaceWorkflow: (workflowId?: string) => void
  }
  /** A new table file, from the Table kit. */
  onCreateTable: () => void
}

export function buildWorkspaceEditorContentProps(input: WorkspaceScreenEditorInput): WorkspaceEditorContentProps {
  const { agentPanel, templateDialogs, workflows } = input
  const openAgentPanel = () => {
    agentPanel.setOpen(true)
    agentPanel.setHistoryOpen(false)
  }
  return {
    activeWorkspaceTab: input.activeWorkspaceTab,
    activeWorkspaceTabId: input.activeWorkspaceTabId,
    galleryPanelProps: input.galleryPanelProps,
    onOpenWorkflow: workflows.openTableFileWorkflow,
    onOpenGlobalWorkflow: workflows.openWorkspaceWorkflow,
    onOpenWorkflows: () => workflows.openWorkspaceWorkflow(),
    onCreateDocument: () => templateDialogs.openDocumentTemplateDialog(''),
    onCreateTable: input.onCreateTable,
    onOpenAgent: () => {
      openAgentPanel()
      window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
    },
    workspaceTabs: input.workspaceTabs,
    rootPath: input.rootPath,
  }
}
/** The active pane inside the editor column. */
export function WorkspaceScreenEditor(input: WorkspaceScreenEditorInput) {
  return (
    <div className="workspace-screen-editor flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <WorkspaceEditorPane>
        <WorkspaceEditorContent {...buildWorkspaceEditorContentProps(input)} />
      </WorkspaceEditorPane>
    </div>
  )
}
