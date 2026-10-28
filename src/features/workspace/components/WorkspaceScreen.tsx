/**
 * Composition root for the workspace window: sidebar tree, tab strip, editor
 * panes, and the Agent sidebar. It owns tab state, create
 * flows, and the bridges that feed document and table context to
 * the Agent. It is intentionally being split into focused hooks; do not add
 * new responsibilities here (see docs/superpowers/plans, Task 1.4).
 */
import { setInvalidationWorkspaceRoot } from '@/api/invalidation'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { expandedTableFiles, withTableFileChildren } from '@/features/workspace/lib/tableFileChildren'
import { useTableFileChildren } from '@/features/workspace/hooks/useTableFileChildren'
import {
  buildPrivateSectionTreeNodes,
} from '@/features/workspace/lib/workspaceTree'
import type { WorkflowRouteContext } from '@/features/workflow/public'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { getKitionAccountLinks, isKitionAccountSessionUsable, useKitionAccount } from '@/features/account/public'
import { useWorkspaceAgent } from '@/features/agent/public'
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import { WorkspaceEditorFrame } from '@/features/workspace/components/WorkspaceEditorFrame'
import { WorkspaceAgentChrome } from '@/features/workspace/components/WorkspaceAgentChrome'
import {
  WorkspaceScreenSidebar,
  WorkspaceScreenSidebarFooter,
} from '@/features/workspace/components/WorkspaceScreenSidebar'
import { WorkspaceLayout } from '@/features/workspace/components/WorkspaceLayout'
import { WorkspaceScreenTopbar } from '@/features/workspace/components/WorkspaceScreenTopbar'
import { useWorkspaceChrome } from '@/features/workspace/hooks/useWorkspaceChrome'
import { useWorkspaceEditorPanels } from '@/features/workspace/hooks/useWorkspaceEditorPanels'
import { useWorkspaceFileOpener } from '@/features/workspace/hooks/useWorkspaceFileOpener'
import { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import { useWorkspaceTreeState } from '@/features/workspace/hooks/useWorkspaceTreeState'
import { useWorkspaceTabs } from '@/features/workspace/hooks/useWorkspaceTabs'
import { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'
import { useWorkspaceAgentTurnContext } from '@/features/workspace/hooks/useWorkspaceAgentTurnContext'
import { useWorkspaceOpeners } from '@/features/workspace/hooks/useWorkspaceOpeners'
import { useWorkspaceTreeRowActions } from '@/features/workspace/hooks/useWorkspaceTreeRowActions'
import { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import { useWorkspaceAgentPanel } from '@/features/workspace/hooks/useWorkspaceAgentPanel'
import { useWorkspaceAgentChatEntryPoints } from '@/features/workspace/hooks/useWorkspaceAgentChatEntryPoints'
import { useWorkspaceTabControllers } from '@/features/workspace/hooks/useWorkspaceTabControllers'
import { useUnsavedCloseQuestion } from '@/features/workspace/components/UnsavedCloseDialog'
import { useUnsavedLeaveGuard } from '@/features/workspace/hooks/useUnsavedLeaveGuard'
import { WorkspaceDialogs } from '@/features/workspace/components/WorkspaceDialogs'
import { WorkspaceAgentPane } from '@/features/workspace/components/WorkspaceAgentPane'
import { useWorkspaceSidebarNavigation } from '@/features/workspace/hooks/useWorkspaceSidebarNavigation'
import { useWorkspaceCreateMenu } from '@/features/workspace/hooks/useWorkspaceCreateMenu'
import { useKitCreations } from '@/features/workspace/hooks/useKitCreations'
import { onShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import { useWorkspaceAgentComposer } from '@/features/workspace/hooks/useWorkspaceAgentComposer'
import { useWorkspaceErrorNotice } from '@/features/workspace/hooks/useWorkspaceErrorNotice'
import { inferWorkspaceItemFormat, isEditableWorkspaceFormat, isImageWorkspaceFormat, isVideoWorkspaceFormat } from '@/features/workspace/lib/workspace'
import { resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'
import { buildWorkspaceAgentTurnUpdate } from '@/features/workspace/lib/agentTurnUpdate'
import { notify } from '@/lib/notify'
import { isDesktopRuntime, type WorkspaceDocumentFormat } from '@/services/desktop'

const WorkflowRoute = lazy(() =>
  import('@/features/workflow/pages/WorkflowRoute').then((module) => ({ default: module.WorkflowRoute })),
)

type WorkspaceScreenProps = {
  onOpenSettingsSection?: (section: SettingsSectionKey) => void
  onOpenProfile?: () => void
  onCloseProfile?: () => void
  profileOpen?: boolean
  topbarActionsPortal: HTMLElement | null
  topbarLeadingPortal: HTMLElement | null
  desktopPlatform?: boolean
  onOpenVaultLauncher?: () => void
  workflowOpen?: boolean
  workflowContext?: WorkflowRouteContext | null
  workflowSchemaLookup?: (documentId: string, tableId: string) => Promise<TableSchema>
  onCloseWorkflow?: () => void
  /** Opens the standalone full-text search modal (Codex-style palette). */
  onOpenSearch?: () => void
}


export function WorkspaceScreen({
  onOpenSettingsSection,
  onOpenProfile,
  onCloseProfile,
  profileOpen = false,
  topbarActionsPortal,
  topbarLeadingPortal,
  desktopPlatform = false,
  onOpenVaultLauncher,
  workflowOpen = false,
  workflowContext = null,
  workflowSchemaLookup,
  onCloseWorkflow,
  onOpenSearch,
}: WorkspaceScreenProps) {
  const { t } = useTranslation('workspace')
  const { settings, setSettings } = useDesktopSettings()
  const kitionAccount = useKitionAccount()
  const ensureHostedAccountReady = useCallback(
    async () => isKitionAccountSessionUsable(await kitionAccount.ensureReady()),
    [kitionAccount.ensureReady],
  )
  const kitionAccountLinks = getKitionAccountLinks(kitionAccount.state.session)
  const workspaceTree = useWorkspaceTreeState()
  const {
    createMenuFolder,
    files,
    openCreateFormatMenu,
    rootPath,
    treeItems,
    treeMetadata,
  } = workspaceTree
  const fileTreeNodes = useMemo(
    () => buildPrivateSectionTreeNodes(treeItems, treeMetadata),
    [treeItems, treeMetadata],
  )
  // An expanded table file lists its tables and dashboards, read through the Table kit.
  const expandedTables = useMemo(
    () => expandedTableFiles(fileTreeNodes, workspaceTree.expandedPaths),
    [fileTreeNodes, workspaceTree.expandedPaths],
  )
  const tableFileChildren = useTableFileChildren(expandedTables)
  const workspaceTreeNodes = useMemo(
    () => withTableFileChildren(fileTreeNodes, tableFileChildren),
    [fileTreeNodes, tableFileChildren],
  )
  useEffect(() => {
    setInvalidationWorkspaceRoot(rootPath)
  }, [rootPath])
  const [error, setError] = useState('')
  const [, setFeedback] = useState('')
  const [saving, setSaving] = useState(false)
  const chrome = useWorkspaceChrome()
  const {
    agentSidebarWidth,
    effectiveSidebarWidth,
    handleAgentSidebarResize,
    handleWorkspaceSidebarResize,
    setSidebarSectionsExpanded,
    sidebarSectionsExpanded,
    toggleSidebarCollapsed,
    toggleSidebarSection,
  } = chrome
  const openFileViewerTabRef = useRef<
    (path: string, format: WorkspaceDocumentFormat) => void
  >(() => {})
  const setActiveWorkspaceTabIdRef = useRef<(tabId: string) => void>(() => {})
  const refreshWorkspaceDocumentsRef = useRef<
    (preferredPath?: string, options?: { silent?: boolean; treeOnly?: boolean }) => Promise<boolean>
  >(async () => true)
  const agentDocumentStateRef = useRef({
    clearModifiedPath: (_path: string) => {},
    modifiedPaths: new Set<string>(),
  })
  const agentTurn = useWorkspaceAgentTurnContext()
  const agentTurnContextRef = agentTurn.turnContextRef
  const getAgentTurnContext = agentTurn.getTurnContext
  const {
    activeResourcePath,
    setActiveResourcePath,
    applyWorkspaceDocument,
    openDocument,
  } = useWorkspaceFileOpener({
    files,
    rootPath,
    onError: setError,
    onFeedback: setFeedback,
    onOpenFileViewerTab: (path, format) => openFileViewerTabRef.current(path, format),
    setTreeItems: workspaceTree.setTreeItems,
  })

  const workspaceAgent = useWorkspaceAgent({
    settings,
    rootPath,
    workspaceTreeItems: treeItems,
    onError: setError,
    onFeedback: setFeedback,
    ensureHostedAccountReady,
    onSettingsSaved: setSettings,
    onWorkspaceArtifactsSaved: async () => {
      await refreshWorkspaceDocumentsRef.current(undefined, { silent: true, treeOnly: true })
    },
    onWorkspaceDocumentsModified: async () => {
      await refreshWorkspaceDocumentsRef.current(undefined, { silent: true, treeOnly: true })
    },
    getTurnContext: getAgentTurnContext,
  })
  const {
    agentBusySessions,
    agentDrafts,
    agentLocalSources,
    agentModifiedDocumentPaths,
    agentSessions,
    agentSessionViews,
    clearPendingFocusedSessionId,
    clearModifiedDocumentPath,
    createNewAgentChat,
    addAgentDocumentContext,
    addAgentLocalSource,
    openAgentSession,
    pendingFocusedSessionId,
    refreshAgentSessions,
    resolveAgentDocumentContexts,
    selectedAgentModel,
    sendAgentContextAction,
    sendAiComposerMessage,
    setAgentDraft,
    setAgentModifiedDocumentPaths,
    stopAgentMessage,
  } = workspaceAgent
  agentDocumentStateRef.current = {
    clearModifiedPath: clearModifiedDocumentPath,
    modifiedPaths: agentModifiedDocumentPaths,
  }

  const {
    activeWorkspaceTab,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    filterWorkspaceTabs,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    setActiveWorkspaceTabId,
    upsertWorkspaceTab,
    workspaceTabs,
  } = useWorkspaceTabs({
    rootPath,
    onActivateGallery: (kind) => {
      setActiveResourcePath('')
      setSidebarSectionsExpanded((current) => ({ ...current, [kind]: true }))
    },
  })
  setActiveWorkspaceTabIdRef.current = setActiveWorkspaceTabId

  // Closing a tab needs the workflow-route guard from the tab strip's
  // onClose: when the last workflow tab goes away, the full-screen
  // /workflow route has nothing left to scope to and should exit.
  // Shared between the tab strip's close button, the middle-click
  // shortcut, and the Cmd/Ctrl+W keyboard handler below.



  const {
    openTableFileWorkflow,
    openWorkspaceWorkflow,
  } = useWorkspaceOpeners({
    upsertWorkspaceTab,
    setActiveResourcePath,
    workflowOpen,
    onCloseWorkflow,
  })
  const unsavedClose = useUnsavedCloseQuestion()
  useUnsavedLeaveGuard(unsavedClose.ask)
  const { handleCloseWorkspaceTabById, openFileViewerTab } = useWorkspaceTabControllers({
    workspaceTabs,
    activeWorkspaceTab,
    activeWorkspaceTabId,
    closeWorkspaceTab,
    upsertWorkspaceTab,
    setActiveResourcePath,
    workflowOpen,
    onCloseWorkflow,
    openDocument,
    askUnsavedClose: unsavedClose.ask,
  })

  // The table file the workflow workbench is scoped to, when its tab names one.
  const activeTableFilePath = activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.tablePath ?? '' : ''
  agentTurn.updateTurnContext(buildWorkspaceAgentTurnUpdate({ activeWorkspaceTab }))
  const activeWorkspaceDocumentPath = resolveAgentActiveDocument(activeWorkspaceTab).path
  const agentPanel = useWorkspaceAgentPanel({
    rootPath,
    agentSessions,
    refreshAgentSessions,
    createNewAgentChat,
    openAgentSession,
    pendingFocusedSessionId,
    clearPendingFocusedSessionId,
    activeWorkspaceDocumentPath,
    agentSidebarWidth,
  })
  const {
    open: workspaceAgentOpen,
    setOpen: setWorkspaceAgentOpen,
    setHistoryOpen: setWorkspaceAgentHistoryOpen,
    activeSessionId: activeWorkspaceAgentSessionId,
    setActiveSessionId: setActiveWorkspaceAgentSessionId,
    activeSession: activeWorkspaceAgentSession,
  } = agentPanel
  const activeAgentDocumentContextPaths = activeWorkspaceAgentSession
    ? resolveAgentDocumentContexts(
      activeWorkspaceAgentSession.id,
      activeWorkspaceDocumentPath,
    )
    : []

  const treeActions = useWorkspaceTreeActions({
    activeResourcePath,
    applyWorkspaceDocument,
    filterWorkspaceTabs,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    setActiveResourcePath,
    setActiveWorkspaceTabId,
    setAgentModifiedDocumentPaths,
    setError,
    setFeedback,
    setSaving,
    treeState: workspaceTree,
  })
  const {
    createDocument,
    createDocumentInside,
    createFolder,
    deleteDocumentNode,
    importBrowserFiles,
    openWorkspaceFolder,
    refreshWorkspaceDocuments,
    renameWorkspaceNode,
  } = treeActions

  refreshWorkspaceDocumentsRef.current = refreshWorkspaceDocuments

  const templateDialogs = useWorkspaceTemplateDialogs({ createDocument })
  const { openDocumentTemplateDialog } = templateDialogs

  const rowActions = useWorkspaceTreeRowActions({
    deleteDocumentNode,
    renameWorkspaceNode,
  })

  const createFlows = useWorkspaceCreateFlows({
    createMenuFolder,
    createFolder,
  })

  const workspaceMoveTargets = useMemo(
    () => workspaceTree.flatTreeNodes.filter(
      (node) => !node.virtual && (node.type === 'folder' || isEditableWorkspaceFormat(node.format)),
    ),
    [workspaceTree.flatTreeNodes],
  )

  const imageFiles = useMemo(
    () => files.filter((item) => isImageWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path))),
    [files],
  )
  const videoFiles = useMemo(
    () => files.filter((item) => isVideoWorkspaceFormat(item.format || inferWorkspaceItemFormat(item.path))),
    [files],
  )

  openFileViewerTabRef.current = openFileViewerTab

  const workflowWorkbench = workflowOpen && workflowSchemaLookup ? (
    <div data-testid="workspace-workflow-workbench" className="h-full min-h-0 overflow-hidden bg-background">
      <Suspense fallback={null}>
        <WorkflowRoute
          workflowContext={workflowContext}
          schemaLookup={workflowSchemaLookup}
          scopedTablePath={activeTableFilePath || undefined}
          onExit={onCloseWorkflow}
          rootPath={rootPath}
        />
      </Suspense>
    </div>
  ) : null


  const openWorkspaceAgentPanel = useCallback(() => {
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)
  }, [setWorkspaceAgentHistoryOpen, setWorkspaceAgentOpen])
  const chatEntryPoints = useWorkspaceAgentChatEntryPoints({
    openPanel: openWorkspaceAgentPanel,
    activeSessionId: activeWorkspaceAgentSessionId,
    setActiveSessionId: setActiveWorkspaceAgentSessionId,
    createNewAgentChat,
    agentDrafts,
    setAgentDraft,
    addAgentDocumentContext,
    activeWorkspaceDocumentPath,
    openDocument,
  })

  const { agentNeedsModelConfig, galleryPanelProps } =
    useWorkspaceEditorPanels({
      activeWorkspaceTab,
      error,
      imageFiles,
      onOpenDocument: openDocument,
      videoFiles,
    })

  const openModelSettings = useMemo(
    () => (onOpenSettingsSection ? () => onOpenSettingsSection('models') : undefined),
    [onOpenSettingsSection],
  )
  useWorkspaceErrorNotice({ error, agentNeedsModelConfig, onOpenModelSettings: openModelSettings })


  const agentComposer = useWorkspaceAgentComposer({
    activeSession: activeWorkspaceAgentSession,
    agentDrafts,
    agentLocalSources,
    addAgentLocalSource,
    sendAiComposerMessage,
    setError,
  })

  const workspaceRightPane = workspaceAgentOpen ? (
    <WorkspaceAgentPane
      rootPath={rootPath}
      agent={workspaceAgent}
      session={activeWorkspaceAgentSession}
      imageContext={agentTurnContextRef.current}
      activeWorkspaceTab={activeWorkspaceTab}
      activeWorkspaceDocumentPath={activeWorkspaceDocumentPath}
      documentContextPaths={activeAgentDocumentContextPaths}
      kitionAccount={kitionAccount}
      kitionAccountLinks={kitionAccountLinks}
      onOpenSettingsSection={onOpenSettingsSection}
      onAddLocalSource={() => void agentComposer.addLocalAnalysisSource()}
      onSend={(sessionId, intent) => void agentComposer.sendMessage(sessionId, intent)}
      onOpenDocument={(path) => void openDocument(path)}
      onReviewModifiedArtifact={(path) => void openDocument(path)}
      onImportFiles={(files, target) => importBrowserFiles(files, target)}
    />
  ) : null

  const { openSidebarPath } = useWorkspaceSidebarNavigation({
    workflowOpen,
    onCloseWorkflow,
    onCloseProfile,
    openWorkflows: (tablePath) => (tablePath ? openTableFileWorkflow(tablePath) : openWorkspaceWorkflow()),
    openDocument,
  })

  // A kit wrote a new file (an export, a project from a clip): show it, and open it when asked.
  useEffect(() => onShowWorkspaceFile(({ path, open }) => {
    void Promise.resolve(refreshWorkspaceDocuments(path, { silent: true })).then(() => {
      if (open) openSidebarPath(path)
    })
  }), [openSidebarPath, refreshWorkspaceDocuments])

  const kitCreations = useKitCreations({
    refreshWorkspaceDocuments,
    openPath: openSidebarPath,
    onError: setError,
  })

  const createMenuActions = useWorkspaceCreateMenu({
    createFlows,
    createMenuFolder,
    closeCreateMenu: () => workspaceTree.setCreateMenuOpen(false),
    openCreateFormatMenu,
    expandPrivateSection: () => setSidebarSectionsExpanded((current) => ({ ...current, private: true })),
    createDocumentInside,
    openDocumentTemplateDialog,
    kitCreations,
    openWorkspaceWorkflow,
    openTableFileWorkflow,
    onCloseProfile,
  })

  // The empty state's "New table": a table file from the Table kit, at the workspace root.
  const createTableFile = useCallback(() => {
    void kitCreations.find((kit) => kit.id === 'table')?.create('')
  }, [kitCreations])

  return (
    <>
      <WorkspaceScreenTopbar
        tabsPortal={topbarLeadingPortal}
        chrome={chrome}
        tabs={{ workspaceTabs, activeWorkspaceTab, activeWorkspaceTabId, activateWorkspaceTab, closeTab: handleCloseWorkspaceTabById }}
        workflowOpen={workflowOpen}
        onCloseWorkflow={onCloseWorkflow}
        onCloseProfile={onCloseProfile}
      />
      <WorkspaceAgentChrome portal={topbarActionsPortal} panel={agentPanel} sessions={agentSessions} />
      {unsavedClose.dialog}
      <WorkspaceDialogs
        saving={saving}
        createFlows={createFlows}
        templateDialogs={templateDialogs}
      />
      <WorkspaceLayout
        sidebarWidth={effectiveSidebarWidth}
        rightPane={workspaceRightPane}
        rightPaneWidth={workspaceRightPane ? agentSidebarWidth : undefined}
        onResizeSidebar={handleWorkspaceSidebarResize}
        onResizeRightPane={handleAgentSidebarResize}
        sidebar={
          <WorkspaceScreenSidebar
            tree={workspaceTree}
            treeNodes={workspaceTreeNodes}
            moveTargets={workspaceMoveTargets}
            activePath={activeResourcePath}
            modifiedPaths={agentModifiedDocumentPaths}
            createMenuActions={createMenuActions}
            treeActions={treeActions}
            rowActions={rowActions}
            chat={chatEntryPoints}
            chrome={{
              privateExpanded: sidebarSectionsExpanded.private,
              onTogglePrivate: () => toggleSidebarSection('private'),
              onToggleSidebar: toggleSidebarCollapsed,
            }}
            desktop={isDesktopRuntime()}
            onOpen={openSidebarPath}
            onOpenSearch={onOpenSearch}
            onRefreshed={() => notify.success(t('feedback.refreshed'))}
          />
        }
        sidebarFooter={
          onOpenSettingsSection ? (
            <WorkspaceScreenSidebarFooter
              activeItem={profileOpen ? 'profile' : null}
              onOpenProfile={onOpenProfile}
              onOpenSettings={() => onOpenSettingsSection('general')}
              onOpenVaultLauncher={onOpenVaultLauncher}
            />
          ) : null
        }
        editor={(
          <WorkspaceEditorFrame
            workbench={workflowWorkbench}
            editor={{
              rootPath,
              workspaceTabs,
              activeWorkspaceTab,
              activeWorkspaceTabId,
              galleryPanelProps,
              agentPanel,
              templateDialogs,
              workflows: {
                openTableFileWorkflow,
                openWorkspaceWorkflow,
              },
              onCreateTable: createTableFile,
            }}
          />
        )}
      />
    </>
  )
}
