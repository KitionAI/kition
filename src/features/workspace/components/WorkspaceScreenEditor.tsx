import type { ComponentProps } from 'react'

import type { AgentSession } from '@/api/agent'
import type { WorkspaceAgentPanelState } from '@/features/workspace/components/WorkspaceAgentChrome'
import { WorkspaceEditorContent } from '@/features/workspace/components/WorkspaceEditorContent'
import { WorkspaceEditorPane } from '@/features/workspace/components/WorkspaceEditorPane'
import type { useWorkspaceBrowserPanel } from '@/features/workspace/hooks/useWorkspaceBrowserPanel'
import type { useWorkspaceTableAgentContext } from '@/features/workspace/hooks/useWorkspaceTableAgentContext'
import type { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'

export type WorkspaceEditorContentProps = ComponentProps<typeof WorkspaceEditorContent>

type RevisionDecision = Parameters<WorkspaceEditorContentProps['onResolveAllDocumentRevisionChanges']>[0]

/** What the editor column needs, as the bundles the workspace hooks already return. */
export type WorkspaceScreenEditorInput = {
  rootPath: string
  workspaceTabs: WorkspaceEditorContentProps['workspaceTabs']
  activeWorkspaceTab: WorkspaceEditorContentProps['activeWorkspaceTab']
  activeWorkspaceTabId: string
  documentSession: Pick<
    WorkspaceEditorContentProps,
    'activeDocument' | 'activeDocumentFormat' | 'activeDocumentRevision' | 'draftContent'
    | 'editorResetVersions' | 'documentRevisionSaving' | 'getOpenedDocumentDraftEntry'
  > & {
    decideDocumentRevisionChange: (path: string, changeId: string, decision: RevisionDecision) => void
    resolveAllDocumentRevisionChanges: (path: string, decision: RevisionDecision) => void
    handleDraftContentChange: (value: string) => void
    openDocument: (path: string) => unknown
  }
  editorView: { locked: boolean; editorMode: WorkspaceEditorContentProps['editorMode'] }
  editorPreviewHtml: string
  galleryPanelProps: WorkspaceEditorContentProps['galleryPanelProps']
  browserPanel: Pick<
    ReturnType<typeof useWorkspaceBrowserPanel>,
    'browserPanelPhase' | 'browserToolbarStatus' | 'handleBrowserNavigate' | 'handleBrowserBack'
    | 'handleBrowserForward' | 'handleBrowserReload' | 'handleBrowserStop'
  >
  tableAgent: Pick<ReturnType<typeof useWorkspaceTableAgentContext>, 'browserOriginDocumentPath' | 'handleContextChange'>
  agentPanel: Pick<WorkspaceAgentPanelState, 'open' | 'setOpen' | 'setHistoryOpen'>
  activeAgentSession: AgentSession | null
  agentBusySessions: Set<number>
  stopAgentMessage: (sessionId: number) => void
  whiteboard: {
    available: boolean
    onBridgeChange: WorkspaceEditorContentProps['onWhiteboardAgentBridgeChange']
    onGenerateImage: WorkspaceEditorContentProps['onGenerateWhiteboardImage']
  }
  design: {
    available: boolean
    onBridgeChange: WorkspaceEditorContentProps['onDesignAgentBridgeChange']
    onGenerateImage: WorkspaceEditorContentProps['onGenerateDesignImage']
  }
  templateDialogs: Pick<
    ReturnType<typeof useWorkspaceTemplateDialogs>,
    'documentEditorFocusRequest' | 'openDocumentTemplateDialog' | 'openKitableTemplateDialog'
  >
  workflows: {
    createForKitable: WorkspaceEditorContentProps['onCreateWorkflow']
    openKitableWorkflow: WorkspaceEditorContentProps['onOpenWorkflow']
    openWorkspaceWorkflow: (workflowId?: string) => void
  }
  onAskDocumentAgent: WorkspaceEditorContentProps['onAskDocumentAgent']
  documentTranslation: WorkspaceEditorContentProps['documentTranslation']
  onAgentInsertionContextChange: WorkspaceEditorContentProps['onAgentInsertionContextChange']
  onSaveDocumentTitle: (nextTitle: string) => unknown
  onToolbarMount: WorkspaceEditorContentProps['onToolbarMount']
  onSetEditorMode: WorkspaceEditorContentProps['onSetEditorMode']
  /** Clears the transient feedback line when the split editor changes. */
  clearFeedback: () => void
}

export function buildWorkspaceEditorContentProps(input: WorkspaceScreenEditorInput): WorkspaceEditorContentProps {
  const { documentSession, browserPanel, tableAgent, agentPanel, activeAgentSession, whiteboard, design, templateDialogs, workflows } = input
  const revision = documentSession.activeDocumentRevision
  const openAgentPanel = () => {
    agentPanel.setOpen(true)
    agentPanel.setHistoryOpen(false)
  }
  return {
    designRoot: input.rootPath,
    activeDocument: documentSession.activeDocument,
    activeDocumentFormat: documentSession.activeDocumentFormat,
    activeDocumentRevision: revision,
    activeWorkspaceTab: input.activeWorkspaceTab,
    activeWorkspaceTabId: input.activeWorkspaceTabId,
    documentTitle: documentSession.activeDocument ? getWorkspaceItemTitle(documentSession.activeDocument.name) : '',
    draftContent: documentSession.draftContent,
    hasActiveDocument: Boolean(documentSession.activeDocument),
    editorLocked: input.editorView.locked,
    editorMode: input.editorView.editorMode,
    editorPreviewHtml: input.editorPreviewHtml,
    editorResetVersions: documentSession.editorResetVersions,
    documentRevisionSaving: documentSession.documentRevisionSaving,
    documentEditorFocusRequest: templateDialogs.documentEditorFocusRequest,
    galleryPanelProps: input.galleryPanelProps,
    browserOriginDocumentPath: tableAgent.browserOriginDocumentPath,
    browserPanelPhase: browserPanel.browserPanelPhase,
    browserToolbarStatus: browserPanel.browserToolbarStatus,
    onBrowserNavigate: (address) => void browserPanel.handleBrowserNavigate(address),
    onBrowserBack: browserPanel.handleBrowserBack,
    onBrowserForward: browserPanel.handleBrowserForward,
    onBrowserReload: browserPanel.handleBrowserReload,
    onBrowserStop: browserPanel.handleBrowserStop,
    getOpenedDocumentDraftEntry: documentSession.getOpenedDocumentDraftEntry,
    whiteboardAgentAvailable: whiteboard.available,
    whiteboardAgentBusy: activeAgentSession ? input.agentBusySessions.has(activeAgentSession.id) : false,
    onWhiteboardAgentBridgeChange: whiteboard.onBridgeChange,
    onCancelWhiteboardAgent: activeAgentSession ? () => input.stopAgentMessage(activeAgentSession.id) : undefined,
    onGenerateWhiteboardImage: whiteboard.onGenerateImage,
    designAgentAvailable: design.available,
    onDesignAgentBridgeChange: design.onBridgeChange,
    onGenerateDesignImage: design.available ? design.onGenerateImage : undefined,
    onCancelDesignAgent: activeAgentSession ? () => input.stopAgentMessage(activeAgentSession.id) : undefined,
    onTableAgentContextChange: tableAgent.handleContextChange,
    onCreateWorkflow: workflows.createForKitable,
    onOpenWorkflow: workflows.openKitableWorkflow,
    onOpenGlobalWorkflow: workflows.openWorkspaceWorkflow,
    onOpenWorkflows: () => workflows.openWorkspaceWorkflow(),
    onCreateDocument: () => templateDialogs.openDocumentTemplateDialog(''),
    onCreateTable: () => templateDialogs.openKitableTemplateDialog(''),
    onOpenAgent: () => {
      openAgentPanel()
      window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
    },
    onAskDocumentAgent: input.onAskDocumentAgent,
    documentTranslation: input.documentTranslation,
    onAgentInsertionContextChange: input.onAgentInsertionContextChange,
    onSaveDocumentTitle: (nextTitle) => void input.onSaveDocumentTitle(nextTitle),
    onDecideDocumentRevisionChange: (changeId, decision) => {
      if (revision) documentSession.decideDocumentRevisionChange(revision.path, changeId, decision)
    },
    onResolveAllDocumentRevisionChanges: (decision) => {
      if (revision) documentSession.resolveAllDocumentRevisionChanges(revision.path, decision)
    },
    onSplitEditorChange: (value) => {
      documentSession.handleDraftContentChange(value)
      input.clearFeedback()
    },
    onOpenDocument: (path) => void documentSession.openDocument(path),
    onToolbarMount: input.onToolbarMount,
    onSetEditorMode: input.onSetEditorMode,
    tableAgentOpen: agentPanel.open,
    onTableAgentOpenChange: (open) => {
      agentPanel.setOpen(open)
      agentPanel.setHistoryOpen(false)
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
