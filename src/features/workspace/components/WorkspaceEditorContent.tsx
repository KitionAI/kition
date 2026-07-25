import type { ComponentProps } from 'react'
import { lazy, Suspense, useMemo } from 'react'
import { BookOpen, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/registry/ui/button'
import type { OpenedDocumentDraftCacheEntry } from '@/features/document/lib/openedDocumentDrafts'
import { WorkspaceDocumentInlineTitle } from '@/features/workspace/components/WorkspaceDocumentInlineTitle'
import { openWorkflowDetail } from '@/features/workflow/lib/openWorkflowRoute'
import { WorkspaceBrowserToolbar } from '@/features/workspace/components/WorkspaceBrowserToolbar'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { cn } from '@/lib/utils'
import type {
  BrowserSessionPanelState,
  WorkspaceDocument,
  WorkspaceDocumentFormat,
} from '@/services/desktop'

const DocumentHtmlPreviewPane = lazy(() =>
  import('@/features/document/components/DocumentHtmlPreviewPane').then((module) => ({ default: module.DocumentHtmlPreviewPane })),
)
const DocumentMarkdownEditorPane = lazy(() =>
  import('@/features/document/components/DocumentMarkdownEditorPane').then((module) => ({ default: module.DocumentMarkdownEditorPane })),
)
const DocumentSplitEditorPane = lazy(() =>
  import('@/features/document/components/DocumentSplitEditorPane').then((module) => ({ default: module.DocumentSplitEditorPane })),
)
const MarkdownSourceEditor = lazy(() =>
  import('@/features/document/components/MarkdownSourceEditor').then((module) => ({ default: module.MarkdownSourceEditor })),
)
const TableEditorPane = lazy(() =>
  import('@/features/table/components/TableEditorPane').then((module) => ({ default: module.TableEditorPane })),
)
const WorkspaceMediaPanel = lazy(() =>
  import('@/features/workspace/components/WorkspaceMediaPanel').then((module) => ({ default: module.WorkspaceMediaPanel })),
)
const WorkspaceFileViewerPane = lazy(() =>
  import('@/features/workspace/components/WorkspaceFileViewerPane').then((module) => ({ default: module.WorkspaceFileViewerPane })),
)
const WorkflowHomePage = lazy(() =>
  import('@/features/workflow/pages/WorkflowHomePage').then((module) => ({ default: module.WorkflowHomePage })),
)
const WorkflowIndexPage = lazy(() =>
  import('@/features/workflow/pages/WorkflowIndexPage').then((module) => ({ default: module.WorkflowIndexPage })),
)
const EmailSyncWorkflowPage = lazy(() =>
  import('@/features/emailSync/EmailSyncWorkflowPage').then((module) => ({ default: module.EmailSyncWorkflowPage })),
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
        <span className="workspace-browser-tab__spinner" aria-hidden="true" />
      </div>
    </div>
  )
}

type WorkspaceEditorContentProps = {
  activeDocument: WorkspaceDocument | null
  activeDocumentFormat: WorkspaceDocumentFormat
  activeWorkspaceTab: WorkspaceTab | undefined
  activeWorkspaceTabId: string
  documentTitle: string
  draftContent: string
  hasActiveDocument: boolean
  editorLocked: boolean
  editorMode: 'rich' | 'split' | 'source' | 'preview'
  editorPreviewHtml: string
  editorResetVersions: Record<string, number>
  galleryPanelProps: ComponentProps<typeof WorkspaceMediaPanel> | null
  browserOriginDocumentPath?: string
  browserPanelPhase: 'loading' | 'ready' | 'unavailable' | 'empty'
  browserToolbarStatus: Pick<
    BrowserSessionPanelState,
    'url' | 'canGoBack' | 'canGoForward' | 'isLoading'
  >
  onBrowserNavigate: (address: string) => void
  onBrowserBack: () => void
  onBrowserForward: () => void
  onBrowserReload: () => void
  onBrowserStop: () => void
  getOpenedDocumentDraftEntry: (path: string) => OpenedDocumentDraftCacheEntry | null
  onTableAgentContextChange?: ComponentProps<typeof TableEditorPane>['onAgentContextChange']
  onCreateWorkflow?: (kitablePath: string) => void
  onOpenWorkflow?: (kitablePath: string, workflowId: string) => void
  onOpenGlobalWorkflow?: (workflowId: string) => void
  onSaveDocumentTitle: (nextTitle: string) => void
  onSplitEditorChange: (value: string) => void
     
                                           
                                                               
                                               
     
  onOpenDocument?: (path: string, opts?: { line?: number; section?: string }) => void
  onTableAgentOpenChange: (open: boolean) => void
                                                       
  onToolbarMount?: (node: HTMLElement | null) => void
                                          
  onSetEditorMode: (mode: 'rich' | 'split' | 'source' | 'preview') => void
  tableAgentOpen: boolean
  workspaceTabs: WorkspaceTab[]
  /** Active workspace root. Forwarded to mounted workbench panes that
   *  need to scope their data fetches to this workspace — without it
   *  the workflow trigger-table picker would pull rows from sibling
   *  workspaces. */
  rootPath: string
}

export function WorkspaceEditorContent({
  activeDocument,
  activeDocumentFormat,
  activeWorkspaceTab,
  activeWorkspaceTabId,
  documentTitle,
  draftContent,
  hasActiveDocument,
  editorLocked,
  editorMode,
  editorPreviewHtml,
  editorResetVersions,
  galleryPanelProps,
  browserOriginDocumentPath,
  browserPanelPhase,
  browserToolbarStatus,
  onBrowserNavigate,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserStop,
  getOpenedDocumentDraftEntry,
  onTableAgentContextChange,
  onCreateWorkflow,
  onOpenWorkflow,
  onOpenGlobalWorkflow,
  onSaveDocumentTitle,
  onSplitEditorChange,
  onOpenDocument,
  onTableAgentOpenChange,
  onToolbarMount,
  onSetEditorMode,
  tableAgentOpen,
  workspaceTabs,
  rootPath,
}: WorkspaceEditorContentProps) {
  const { t } = useTranslation('workspace')
  const { t: td } = useTranslation('document')
  const openGlobalWorkflow = onOpenGlobalWorkflow ?? openWorkflowDetail
  const showTableAgentAlongsideBrowser =
    activeWorkspaceTab?.type === 'browser' &&
    activeWorkspaceTab.taskMode !== 'browse' &&
    Boolean(browserOriginDocumentPath) &&
    tableAgentOpen

  const inlineTitleElement = useMemo(
    () => (
      <WorkspaceDocumentInlineTitle
        documentPath={activeDocument?.path ?? ''}
        value={documentTitle}
        onCommit={onSaveDocumentTitle}
        onFocusEditor={() => window.dispatchEvent(new CustomEvent('kition:document:focus-editor'))}
        disabled={!hasActiveDocument || editorLocked}
      />
    ),
    [activeDocument?.path, documentTitle, onSaveDocumentTitle, hasActiveDocument, editorLocked],
  )


  return (
    <>
      {activeWorkspaceTab?.type === 'gallery' && galleryPanelProps ? (
        <div className="document-editor-view is-active">
          <Suspense fallback={<EditorPaneFallback />}>
            <WorkspaceMediaPanel {...galleryPanelProps} />
          </Suspense>
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
              <Suspense fallback={null}>
                {tab.workflowId.startsWith('mail_') ? (
                  <EmailSyncWorkflowPage workflowId={tab.workflowId} />
                ) : (
                  <WorkflowHomePage
                    hideClose
                    initialSelectedId={tab.workflowId}
                    scopedKitablePath={tab.kitablePath}
                    rootPath={rootPath}
                  />
                )}
              </Suspense>
            ) : (
              // Index mode: show list of workflows scoped to kitable
              <Suspense fallback={null}>
                <WorkflowIndexPage
                  scopedKitablePath={tab.kitablePath}
                  rootPath={rootPath}
                  onSelectWorkflow={(workflowId, resolvedKitablePath) => {
                    const kitablePath = tab.kitablePath || resolvedKitablePath
                    if (kitablePath && onOpenWorkflow) {
                      onOpenWorkflow(kitablePath, workflowId)
                      return
                    }
                    openGlobalWorkflow(workflowId)
                  }}
                  onCreateWorkflow={tab.kitablePath && onCreateWorkflow
                    ? () => onCreateWorkflow(tab.kitablePath!)
                    : undefined}
                />
              </Suspense>
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
            <Suspense fallback={<EditorPaneFallback />}>
              <WorkspaceFileViewerPane
                path={tab.path}
                format={tab.format}
                active={activeWorkspaceTabId === tab.id}
              />
            </Suspense>
          </div>
        ))}
      {activeWorkspaceTab?.type === 'browser' ? (
        <div className="document-editor-view is-active">
          <div className="workspace-browser-pane">
            <WorkspaceBrowserToolbar
              status={browserToolbarStatus}
              onNavigate={onBrowserNavigate}
              onBack={onBrowserBack}
              onForward={onBrowserForward}
              onReload={onBrowserReload}
              onStop={onBrowserStop}
            />
            <div
              className={cn(
                'workspace-browser-tab',
                browserPanelPhase === 'loading' && 'workspace-browser-tab--loading',
                browserPanelPhase === 'empty' && 'workspace-browser-tab--empty',
              )}
            >
              {browserPanelPhase === 'unavailable' ? (
                <>
                  <div className="workspace-browser-tab__eyebrow">
                    {t('browserTab.eyebrow')}
                  </div>
                  <h2>{activeWorkspaceTab.title}</h2>
                  <p>
                    {t('browserTab.unavailableDescription')}
                  </p>
                  {activeWorkspaceTab.url ? (
                    <code>{activeWorkspaceTab.url}</code>
                  ) : null}
                </>
              ) : browserPanelPhase === 'empty' ? (
                <div className="workspace-browser-tab__empty">
                  <span
                    className="workspace-browser-tab__empty-icon"
                    aria-hidden="true"
                  >
                    <Globe className="size-6" />
                  </span>
                  <p className="workspace-browser-tab__empty-text">
                    {t('browserTab.emptyText')}
                  </p>
                </div>
              ) : browserPanelPhase === 'loading' ? (
                <div
                  className="workspace-browser-tab__status"
                  role="status"
                  aria-live="polite"
                >
                  <span
                    className="workspace-browser-tab__spinner"
                    aria-hidden="true"
                  />
                  <span className="workspace-browser-tab__status-text">
                    {t('browserTab.loadingPage')}
                  </span>
                  {activeWorkspaceTab.url ? (
                    <code>{activeWorkspaceTab.url}</code>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {/* 'table' tab variant hardcodes format:'data', so it doesn't need the activeDocumentFormat guard */}
      <div
        className={cn(
          'document-keepalive-view document-data-editor-stack',
          (
            activeWorkspaceTab?.type === 'table' ||
            (
              (activeWorkspaceTab?.type === 'document' || showTableAgentAlongsideBrowser) &&
              activeDocumentFormat === 'data'
            )
          ) &&
            'is-active',
        )}
      >
        {workspaceTabs
          .filter((tab): tab is Extract<WorkspaceTab, { type: 'document' }> => tab.type === 'document')
          .map((tab) => {
            const entry = getOpenedDocumentDraftEntry(tab.path)
            if (!entry || entry.format !== 'data') {
              return null
            }

            const isActiveDataTab = (
              activeWorkspaceTabId === tab.id &&
              activeWorkspaceTab?.type === 'document' &&
              activeDocumentFormat === 'data'
            ) || (
              showTableAgentAlongsideBrowser &&
              browserOriginDocumentPath === tab.path
            )

            return (
              <div
                key={tab.path}
                className={cn('document-data-editor-stack__pane', isActiveDataTab && 'is-active')}
              >
                <Suspense fallback={<EditorPaneFallback />}>
                  <TableEditorPane
                    documentPath={entry.document.path}
                    markerContent={entry.document.content}
                    agentOpen={tableAgentOpen}
                    onOpenDocument={onOpenDocument}
                    onAgentContextChange={onTableAgentContextChange}
                    onAgentOpenChange={onTableAgentOpenChange}
                  />
                </Suspense>
              </div>
            )
          })}
        {workspaceTabs
          .filter((tab): tab is Extract<WorkspaceTab, { type: 'table' }> => tab.type === 'table')
          .map((tab) => {
            const isActiveTableTab =
              activeWorkspaceTabId === tab.id && activeWorkspaceTab?.type === 'table'
            return (
              <div
                key={tab.id}
                className={cn('document-data-editor-stack__pane', isActiveTableTab && 'is-active')}
              >
                {/* table tab is identified by pinnedTableId, not by parsing a marker file */}
                <Suspense fallback={<EditorPaneFallback />}>
                  <TableEditorPane
                    documentPath={tab.kitablePath}
                    markerContent=""
                    pinnedTableId={tab.tableId}
                    agentOpen={tableAgentOpen}
                    onOpenDocument={onOpenDocument}
                    onAgentContextChange={onTableAgentContextChange}
                    onAgentOpenChange={onTableAgentOpenChange}
                  />
                </Suspense>
              </div>
            )
          })}
      </div>
      {activeWorkspaceTab?.type === 'document' && activeDocumentFormat === 'html' ? (
        <Suspense fallback={<EditorPaneFallback />}>
          <DocumentHtmlPreviewPane html={draftContent} title={documentTitle} />
        </Suspense>
      ) : null}
      {activeWorkspaceTab?.type === 'document'
      && activeDocumentFormat !== 'data'
      && activeDocumentFormat !== 'html' ? (
        <div className="workspace-document-shell">
          {editorMode === 'source' || editorMode === 'split' ? (
            <>
              <div className="document-top-actions-bar">
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    title={td('editor.toolbar.previewMode')}
                    aria-label={td('editor.toolbar.previewMode')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSetEditorMode('preview')}
                    className="h-6 w-6 text-muted-foreground hover:text-foreground [&_svg]:size-4"
                  >
                    <BookOpen />
                  </Button>
                  <span
                    className="document-toolbar-actions-slot flex items-center gap-1"
                    ref={onToolbarMount}
                    data-window-drag-exclude="true"
                  />
                </div>
              </div>
              <div className="document-title-row">
                <div className="document-title-row__title">{inlineTitleElement}</div>
              </div>
            </>
          ) : null}
          <div className="workspace-document-shell__body">
            {editorMode === 'split' ? (
              <Suspense fallback={<EditorPaneFallback />}>
                <DocumentSplitEditorPane
                  value={draftContent}
                  previewHtml={editorPreviewHtml}
                  readOnly={!hasActiveDocument || editorLocked}
                  onChange={onSplitEditorChange}
                />
              </Suspense>
            ) : null}
            {editorMode === 'source' ? (
              <div className="document-editor-view is-active">
                <div className="document-markdown-split document-markdown-split--single">
                  <div className="document-markdown-pane">
                    <Suspense fallback={<EditorPaneFallback />}>
                      <MarkdownSourceEditor
                        value={draftContent}
                        readOnly={!hasActiveDocument || editorLocked}
                        onChange={onSplitEditorChange}
                        placeholder={t('editor.sourcePlaceholder')}
                      />
                    </Suspense>
                  </div>
                </div>
              </div>
            ) : null}
            <div
              className={cn(
                'document-keepalive-view document-rich-editor-stack',
                (editorMode === 'rich' || editorMode === 'preview') && 'is-active',
              )}
            >
              {workspaceTabs
                .filter((tab): tab is Extract<WorkspaceTab, { type: 'document' }> => tab.type === 'document')
                .map((tab) => {
                  const entry = getOpenedDocumentDraftEntry(tab.path)
                  if (!entry || entry.format === 'data' || entry.format === 'html') {
                    return null
                  }

                  const isActiveDocumentTab = activeWorkspaceTabId === tab.id
                    && activeWorkspaceTab?.type === 'document'
                    && (editorMode === 'rich' || editorMode === 'preview')

                  if (!isActiveDocumentTab) {
                    return null
                  }

                  return (
                    <div
                      key={`${tab.uid || tab.path}:${editorResetVersions[tab.path] || 0}`}
                      className="document-rich-editor-stack__pane is-active"
                    >
                      <Suspense fallback={<EditorPaneFallback />}>
                        <DocumentMarkdownEditorPane
                          documentPath={entry.document.path}
                          value={draftContent}
                          readOnly={editorLocked}
                          onChange={onSplitEditorChange}
                          onNavigate={onOpenDocument}
                          inlineTitleSlot={inlineTitleElement}
                          onToolbarMount={onToolbarMount}
                          readingView={editorMode === 'preview'}
                          onSetReadingView={(next) => onSetEditorMode(next ? 'preview' : 'rich')}
                        />
                      </Suspense>
                    </div>
                  )
                })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
