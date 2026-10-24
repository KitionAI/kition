import type { ComponentProps } from 'react'
import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { PaneErrorTrigger } from '@/features/workspace/testing/paneErrorTrigger'
import { WorkspaceEmptyState } from '@/features/workspace/components/WorkspaceEmptyState'
import { openWorkflowDetail } from '@/features/workflow/lib/openWorkflowRoute'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { cn } from '@kition/app-ui/utils'
import type { DesignAgentBridge } from '@/features/design/public'
import type { ImageStudioRequest, ImageStudioStartResult } from '@/features/media-generation/public'

const WorkspaceMediaPanel = lazy(() =>
  import('@/features/workspace/components/WorkspaceMediaPanel').then((module) => ({ default: module.WorkspaceMediaPanel })),
)
const WorkspaceFileViewerPane = lazy(() =>
  import('@/features/workspace/components/WorkspaceFileViewerPane').then((module) => ({ default: module.WorkspaceFileViewerPane })),
)
const DesignEditorPane = lazy(() => import('@/features/design/components/DesignEditorPane').then(module => ({ default: module.DesignEditorPane })))
const WorkflowHomePage = lazy(() =>
  import('@/features/workflow/pages/WorkflowHomePage').then((module) => ({ default: module.WorkflowHomePage })),
)
const WorkflowIndexPage = lazy(() =>
  import('@/features/workflow/pages/WorkflowIndexPage').then((module) => ({ default: module.WorkflowIndexPage })),
)
const EmailSyncWorkflowPage = lazy(() =>
  import('@/features/emailSync/EmailSyncWorkflowPage').then((module) => ({ default: module.EmailSyncWorkflowPage })),
)
const FormSyncWorkflowPage = lazy(() =>
  import('@/features/formSync/FormSyncWorkflowPage').then((module) => ({ default: module.FormSyncWorkflowPage })),
)

function EditorPaneFallback() {
  const { t } = useTranslation('common')
  return (
    <div
      className="document-editor-view is-active bg-background"
      role="status"
      aria-busy="true"
      aria-label={t('actions.loading')}
    >
      <div className="flex h-full min-h-0 items-center justify-center">
        <span className="workspace-pane-spinner" aria-hidden="true" />
      </div>
    </div>
  )
}

/**
 * Every editor surface mounts behind its own error boundary so a crash in one
 * document, table, or workflow view leaves the shell and the other
 * tabs usable. The Suspense fallback covers the lazy chunk load.
 */
function EditorPaneBoundary({
  label,
  fallback,
  paneId,
  children,
}: {
  label?: string
  fallback?: ReactNode
  /** Names the pane for the development-only `?e2e-throw=<paneId>` trigger. */
  paneId?: string
  children: ReactNode
}) {
  return (
    <AppErrorBoundary scope="pane" label={label}>
      {paneId ? <PaneErrorTrigger paneId={paneId} /> : null}
      <Suspense fallback={fallback === undefined ? <EditorPaneFallback /> : fallback}>{children}</Suspense>
    </AppErrorBoundary>
  )
}

type WorkspaceEditorContentProps = {
  activeWorkspaceTab: WorkspaceTab | undefined
  activeWorkspaceTabId: string
  galleryPanelProps: ComponentProps<typeof WorkspaceMediaPanel> | null
  designAgentAvailable?: boolean
  onDesignAgentBridgeChange?: (path: string, bridge: DesignAgentBridge | null) => void
  onCancelDesignAgent?: () => void
  onGenerateDesignImage?: (request: ImageStudioRequest) => Promise<ImageStudioStartResult>
  onOpenWorkflow?: (tablePath: string, workflowId: string) => void
  onOpenGlobalWorkflow?: (workflowId: string) => void
  onOpenWorkflows: () => void
  onCreateDocument: () => void
  onCreateTable: () => void
  onOpenAgent: () => void
  designRoot?: string
  workspaceTabs: WorkspaceTab[]
  /** Active workspace root. Forwarded to mounted workbench panes that
   *  need to scope their data fetches to this workspace — without it
   *  the workflow trigger-table picker would pull rows from sibling
   *  workspaces. */
  rootPath: string
}

export function WorkspaceEditorContent({
  activeWorkspaceTab,
  activeWorkspaceTabId,
  galleryPanelProps,
  designAgentAvailable = false,
  onDesignAgentBridgeChange,
  onCancelDesignAgent,
  onGenerateDesignImage,
  onOpenWorkflow,
  onOpenGlobalWorkflow,
  onOpenWorkflows,
  onCreateDocument,
  onCreateTable,
  onOpenAgent,
  designRoot,
  workspaceTabs,
  rootPath,
}: WorkspaceEditorContentProps) {
  const openGlobalWorkflow = onOpenGlobalWorkflow ?? openWorkflowDetail

  return (
    <>
      {!activeWorkspaceTab ? (
        <WorkspaceEmptyState
          onCreateDocument={onCreateDocument}
          onCreateTable={onCreateTable}
          onOpenAgent={onOpenAgent}
          onOpenWorkflows={onOpenWorkflows}
        />
      ) : null}
      {activeWorkspaceTab?.type === 'gallery' && galleryPanelProps ? (
        <div className="document-editor-view is-active">
          <EditorPaneBoundary>
            <WorkspaceMediaPanel {...galleryPanelProps} />
          </EditorPaneBoundary>
        </div>
      ) : null}
      {workspaceTabs
        .filter((tab): tab is Extract<WorkspaceTab, { type: 'workflow' }> => tab.type === 'workflow')
        .map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'document-editor-view',
              activeWorkspaceTabId === tab.id && activeWorkspaceTab?.type === 'workflow' && 'is-active',
            )}
            // workspace-workflow-workbench is the long-standing testid the
            // real-API workflow suite asserts on; workspace-workflow-tab
            // is the new DocTab-specific hook for canvas e2e + future
            // multi-tab tests. We expose both off the same element so
            // neither contract has to drift when the underlying mount changes.
            data-testid="workspace-workflow-workbench"
            data-workflow-tab="true"
            data-workflow-tab-id={tab.id}
          >
            {tab.workflowId ? (
              // Detail mode: show single workflow editor
              <EditorPaneBoundary fallback={null}>
                {tab.workflowId.startsWith('formsync_') ? (
                  <FormSyncWorkflowPage workflowId={tab.workflowId} />
                ) : tab.workflowId.startsWith('mail_') ? (
                  <EmailSyncWorkflowPage workflowId={tab.workflowId} />
                ) : (
                  <WorkflowHomePage
                    hideClose
                    initialSelectedId={tab.workflowId}
                    scopedTablePath={tab.tablePath}
                    rootPath={rootPath}
                  />
                )}
              </EditorPaneBoundary>
            ) : (
              // Index mode: show list of workflows scoped to a table file
              <EditorPaneBoundary fallback={null}>
                <WorkflowIndexPage
                  scopedTablePath={tab.tablePath}
                  rootPath={rootPath}
                  onSelectWorkflow={(workflowId, resolvedTablePath) => {
                    const tablePath = tab.tablePath || resolvedTablePath
                    if (tablePath && onOpenWorkflow) {
                      onOpenWorkflow(tablePath, workflowId)
                      return
                    }
                    openGlobalWorkflow(workflowId)
                  }}
                />
              </EditorPaneBoundary>
            )}
          </div>
        ))}
      {workspaceTabs
        .filter((tab): tab is Extract<WorkspaceTab, { type: 'file-viewer' }> => tab.type === 'file-viewer')
        .map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'document-editor-view',
              activeWorkspaceTabId === tab.id && activeWorkspaceTab?.type === 'file-viewer' && 'is-active',
            )}
          >
            <EditorPaneBoundary paneId="file">
              <WorkspaceFileViewerPane
                path={tab.path}
                format={tab.format}
                active={activeWorkspaceTabId === tab.id}
                onOpenAgent={onOpenAgent}
              />
            </EditorPaneBoundary>
          </div>
        ))}
      {workspaceTabs.filter((tab): tab is Extract<WorkspaceTab, { type: 'design' }> => tab.type === 'design').map(tab => (
        <div key={`${designRoot}:${tab.id}`} className={cn('document-editor-view', activeWorkspaceTabId === tab.id && 'is-active')}>
          <EditorPaneBoundary>
            <DesignEditorPane root={designRoot || 'browser-local-workspace'} path={tab.path} title={tab.title} active={activeWorkspaceTabId === tab.id} agentAvailable={designAgentAvailable} onAgentBridgeChange={onDesignAgentBridgeChange} onCancelAgent={onCancelDesignAgent} onGenerateImage={onGenerateDesignImage} />
          </EditorPaneBoundary>
        </div>
      ))}
    </>
  )
}
