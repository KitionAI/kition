import type { ComponentProps } from 'react'
import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { PaneErrorTrigger } from '@/features/workspace/testing/paneErrorTrigger'
import { WorkspaceEmptyState } from '@/features/workspace/components/WorkspaceEmptyState'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/cn'

const WorkspaceMediaPanel = lazy(() =>
  import('@/features/workspace/components/WorkspaceMediaPanel').then((module) => ({ default: module.WorkspaceMediaPanel })),
)
const WorkspaceFileViewerPane = lazy(() =>
  import('@/features/workspace/components/WorkspaceFileViewerPane').then((module) => ({ default: module.WorkspaceFileViewerPane })),
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
 * document, table, or file view leaves the shell and the other
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
  onCreateDocument: () => void
  onCreateTable: () => void
  onOpenAgent: () => void
  workspaceTabs: WorkspaceTab[]
}

export function WorkspaceEditorContent({
  activeWorkspaceTab,
  activeWorkspaceTabId,
  galleryPanelProps,
  onCreateDocument,
  onCreateTable,
  onOpenAgent,
  workspaceTabs,
}: WorkspaceEditorContentProps) {
  return (
    <>
      {!activeWorkspaceTab ? (
        <WorkspaceEmptyState
          onCreateDocument={onCreateDocument}
          onCreateTable={onCreateTable}
          onOpenAgent={onOpenAgent}
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
    </>
  )
}
