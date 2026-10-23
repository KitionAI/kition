/**
 * Composition root for the workspace window: sidebar tree, tab strip, editor
 * panes, and the Agent sidebar. It owns tab state, create
 * flows, and the bridges that feed document, table, and whiteboard context to
 * the Agent. It is intentionally being split into focused hooks; do not add
 * new responsibilities here (see docs/superpowers/plans, Task 1.4).
 */
import { useWorkspaceDesign } from '../hooks/useWorkspaceDesign'
import { setInvalidationWorkspaceRoot } from '@/api/invalidation'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildPrivateSectionTreeNodes,
} from '@/features/workspace/lib/workspaceTree'
import type { WorkflowRouteContext } from '@/features/workflow/public'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { getKitionAccountLinks, isKitionAccountSessionUsable, useKitionAccount } from '@/features/account/public'
import { useWorkspaceAgent } from '@/features/agent/public'
import { useDocumentExport } from '@/features/document/hooks/useDocumentExport'
import { useWorkspaceDocumentSession } from '@/features/document/hooks/useWorkspaceDocumentSession'
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
import { useWorkspaceDerivedState } from '@/features/workspace/hooks/useWorkspaceDerivedState'
import { useWorkspaceTopbarActions } from '@/features/workspace/hooks/useWorkspaceTopbarActions'
import { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import { useWorkspaceTreeState } from '@/features/workspace/hooks/useWorkspaceTreeState'
import { useWorkspaceTabs } from '@/features/workspace/hooks/useWorkspaceTabs'
import { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'
import { useWorkspaceWhiteboardAgentBridge } from '@/features/workspace/hooks/useWorkspaceWhiteboardAgentBridge'
import { useWorkspaceDesignAgentBridge } from '@/features/workspace/hooks/useWorkspaceDesignAgentBridge'
import { useWorkspaceAgentTurnContext } from '@/features/workspace/hooks/useWorkspaceAgentTurnContext'
import { useWorkspaceOpeners } from '@/features/workspace/hooks/useWorkspaceOpeners'
import { useWorkspaceTreeRowActions } from '@/features/workspace/hooks/useWorkspaceTreeRowActions'
import { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import { useWorkspaceAgentPanel } from '@/features/workspace/hooks/useWorkspaceAgentPanel'
import { useWorkspaceAgentChatEntryPoints } from '@/features/workspace/hooks/useWorkspaceAgentChatEntryPoints'
import { useWorkspaceTabControllers } from '@/features/workspace/hooks/useWorkspaceTabControllers'
import { WorkspaceDialogs } from '@/features/workspace/components/WorkspaceDialogs'
import { WorkspaceAgentPane } from '@/features/workspace/components/WorkspaceAgentPane'
import { useWorkspaceSidebarNavigation } from '@/features/workspace/hooks/useWorkspaceSidebarNavigation'
import { useWorkspaceCreateMenu } from '@/features/workspace/hooks/useWorkspaceCreateMenu'
import { useKitCreations } from '@/features/workspace/hooks/useKitCreations'
import { onShowWorkspaceFile } from '@/features/workspace/lib/workspaceFileRequests'
import { useWorkspaceDocumentTitleRename } from '@/features/workspace/hooks/useWorkspaceDocumentTitleRename'
import { useWorkspaceAgentComposer } from '@/features/workspace/hooks/useWorkspaceAgentComposer'
import { useWorkspaceErrorNotice } from '@/features/workspace/hooks/useWorkspaceErrorNotice'
import { useWorkspaceDocumentTranslation } from '@/features/workspace/hooks/useWorkspaceDocumentTranslation'
import { useWorkspaceBoardCreation } from '@/features/workspace/hooks/useWorkspaceBoardCreation'
import { useWhiteboardImageGeneration } from '@/features/workspace/hooks/useWhiteboardImageGeneration'
import { useAgentImageGeneration } from '@/features/workspace/hooks/useAgentImageGeneration'
import { buildDesignImageAgentInstruction } from '@/features/design/public'
import { setPinnedTabsWorkspace } from '@/features/document/editor/hooks/usePinnedTabs'
import { isEditableWorkspaceFormat } from '@/features/workspace/lib/workspace'
import { resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'
import { buildWorkspaceAgentTurnUpdate } from '@/features/workspace/lib/agentTurnUpdate'
import { notify } from '@/lib/notify'
import { cn } from '@kition/app-ui/utils'
import { isDesktopRuntime, type WorkspaceDocument, type WorkspaceDocumentFormat } from '@/services/desktop'

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
  const workspaceTreeNodes = useMemo(
    () => buildPrivateSectionTreeNodes(treeItems, treeMetadata),
    [treeItems, treeMetadata],
  )
  // Pinned tabs storage is workspace-scoped; keep the module-level current root
  // in sync with rootPath so pin/unpin/list operations hit the right bucket.
  useEffect(() => {
    setPinnedTabsWorkspace(rootPath)
    setInvalidationWorkspaceRoot(rootPath)
  }, [rootPath])
  const [error, setError] = useState('')
  const [, setFeedback] = useState('')
  const [documentToolbarPortal, setDocumentToolbarPortal] =
    useState<HTMLElement | null>(null)
  const handleDocumentToolbarMount = useCallback(
    (node: HTMLElement | null) => setDocumentToolbarPortal(node),
    [],
  )
  const chrome = useWorkspaceChrome()
  const {
    agentSidebarWidth,
    editorView,
    effectiveSidebarWidth,
    handleAgentSidebarResize,
    handleWorkspaceSidebarResize,
    itemMenuOpen,
    setEditorView,
    setItemMenuOpen,
    setSidebarSectionsExpanded,
    sidebarSectionsExpanded,
    toggleSidebarCollapsed,
    toggleSidebarSection,
  } = chrome
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const openDocumentTabRef = useRef<(document: WorkspaceDocument) => void>(
    () => {},
  )
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
  const whiteboardBridge = useWorkspaceWhiteboardAgentBridge({ rootPath })
  const whiteboardAgentAvailable = whiteboardBridge.available
  const handleWhiteboardAgentBridgeChange = whiteboardBridge.handleBridgeChange
  const designBridge = useWorkspaceDesignAgentBridge({ rootPath })
  const agentTurn = useWorkspaceAgentTurnContext({
    buildWhiteboardContext: whiteboardBridge.buildActiveContext,
    buildDesignContext: designBridge.buildActiveContext,
  })
  const agentTurnContextRef = agentTurn.turnContextRef
  const handleAgentInsertionContextChange = agentTurn.handleInsertionContextChange
  const getAgentTurnContext = agentTurn.getTurnContext
  const documentSession = useWorkspaceDocumentSession({
    editorLocked: editorView.locked,
    editorMode: editorView.editorMode,
    files,
    rootPath,
    isModifiedDocumentPath: (path) =>
      agentDocumentStateRef.current.modifiedPaths.has(path),
    onClearModifiedDocumentPath: (path) =>
      agentDocumentStateRef.current.clearModifiedPath(path),
    onError: setError,
    onFeedback: setFeedback,
    onOpenDocumentTab: (document) => openDocumentTabRef.current(document),
    onOpenFileViewerTab: (path, format) =>
      openFileViewerTabRef.current(path, format),
    onRequireMarkdownMode: () =>
      setEditorView((current) => ({ ...current, editorMode: 'rich' })),
    setTreeItems: workspaceTree.setTreeItems,
  })
  const {
    activeDocument,
    activeDocumentFormat,
    activeDocumentSession,
    activeResourcePath,
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    closeOpenedDocument,
    draftContent,
    ensureActiveDocumentSaved,
    forgetOpenedDocuments,
    hasUnsavedChanges,
    openModifiedDocumentReview,
    openDocument,
    persistActiveDocument,
    remapOpenedDocuments,
    replaceActiveDocumentText,
    restoreSavedVersion,
    saving,
    selectedPlatform,
    setActiveResourcePath,
    setSaving,
    setSelectedPlatform,
    reviewModifiedDocuments,
  } = documentSession

  const documentExport = useDocumentExport({
    activeDocument,
    activeDocumentFormat,
    draftContent,
    readContent: activeDocumentSession?.isReady() ? () => activeDocumentSession.read() : undefined,
    onError: setError,
    onFeedback: setFeedback,
  })
  const {
    openExportDialog,
  } = documentExport
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
    onWorkspaceDocumentsModified: async (paths) => {
      await Promise.all([
        reviewModifiedDocuments(paths),
        refreshWorkspaceDocumentsRef.current(undefined, { silent: true, treeOnly: true }),
      ])
    },
    onWhiteboardPatch: whiteboardBridge.receivePatch,
    onWhiteboardPatchCancelled: whiteboardBridge.cancelPreview,
    onDesignPatch: designBridge.receivePatch,
    onDesignPatchCancelled: designBridge.cancelPreview,
    prepareActiveDocument: ensureActiveDocumentSaved,
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
    activeDocumentPath: activeDocument?.path || '',
    onOpenDocument: async (path) => openDocument(path),
    onActivateGallery: (kind) => {
      setActiveResourcePath('')
      setSidebarSectionsExpanded((current) => ({ ...current, [kind]: true }))
    },
    // The tab controllers wrote (or, with the user's consent, discarded) the pending save first;
    // the session stops here, and a final write that still fails keeps retrying.
    onCloseDocumentTab: (tab) => closeOpenedDocument(tab.path),
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
    openBoard,
  } = useWorkspaceOpeners({
    upsertWorkspaceTab,
    setActiveResourcePath,
    workflowOpen,
    onCloseWorkflow,
  })
  const design = useWorkspaceDesign({
    root: rootPath,
    activeTab: activeWorkspaceTab,
    upsert: upsertWorkspaceTab,
    refresh: (...args) => refreshWorkspaceDocumentsRef.current(...args),
    closeCreateMenu: () => workspaceTree.setCreateMenuOpen(false),
    expandFolder: workspaceTree.expandFolders,
    beforeOpen: () => {
      if (workflowOpen) onCloseWorkflow?.()
    },
  })

  const { handleCloseWorkspaceTabById, openDocumentTab, openFileViewerTab } = useWorkspaceTabControllers({
    workspaceTabs,
    activeWorkspaceTab,
    activeWorkspaceTabId,
    closeWorkspaceTab,
    upsertWorkspaceTab,
    setActiveResourcePath,
    workflowOpen,
    onCloseWorkflow,
    openDesign: design.open,
    openBoard,
    openDocument,
  })

  // The table file the workflow workbench is scoped to, when its tab names one.
  const activeTableFilePath = activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.tablePath ?? '' : ''
  whiteboardBridge.setActiveBoardPath(activeWorkspaceTab?.type === 'board' ? activeWorkspaceTab.path : '')
  designBridge.setActiveDesignPath(activeWorkspaceTab?.type === 'design' ? activeWorkspaceTab.path : '')
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
  const handleGenerateWhiteboardImage = useWhiteboardImageGeneration({
    activeSessionId: activeWorkspaceAgentSessionId,
    agentBusySessions,
    agentSessionViews,
    available: whiteboardBridge.available,
    bridgesRef: whiteboardBridge.bridgesRef,
    createAgentChat: createNewAgentChat,
    modelAvailable: Boolean(selectedAgentModel?.runtimeModel),
    sendAgentAction: sendAgentContextAction,
    setActiveSessionId: setActiveWorkspaceAgentSessionId,
  })
  const handleGenerateDesignImage = useAgentImageGeneration({
    activeSessionId: activeWorkspaceAgentSessionId,
    agentBusySessions,
    agentSessionViews,
    available: designBridge.available,
    bridgesRef: designBridge.bridgesRef,
    buildInstruction: buildDesignImageAgentInstruction,
    createAgentChat: createNewAgentChat,
    modelAvailable: Boolean(selectedAgentModel?.runtimeModel),
    sendAgentAction: sendAgentContextAction,
    setActiveSessionId: setActiveWorkspaceAgentSessionId,
  })
  const activeAgentDocumentContextPaths = activeWorkspaceAgentSession
    ? resolveAgentDocumentContexts(
      activeWorkspaceAgentSession.id,
      activeWorkspaceDocumentPath,
    )
    : []

  // Files renamed or moved on disk: their tabs and their open document sessions follow.
  const remapOpenedPaths = useCallback((sourcePath: string, targetPath: string) => {
    remapWorkspaceTabPaths(sourcePath, targetPath)
    remapOpenedDocuments(sourcePath, targetPath)
  }, [remapOpenedDocuments, remapWorkspaceTabPaths])
  const treeActions = useWorkspaceTreeActions({
    activeDocument,
    activeResourcePath,
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    filterWorkspaceTabs,
    forgetOpenedDocuments,
    hasUnsavedChanges,
    persistActiveDocument,
    remapWorkspaceTabPaths: remapOpenedPaths,
    renameWorkspaceTabPath,
    setActiveResourcePath,
    setActiveWorkspaceTabId,
    setAgentModifiedDocumentPaths,
    setEditorMode: (mode) =>
      setEditorView((current) => ({ ...current, editorMode: mode })),
    setError,
    setFeedback,
    setSaving,
    setSelectedPlatform,
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

  const boardCreation = useWorkspaceBoardCreation({
    closeCreateMenu: () => workspaceTree.setCreateMenuOpen(false),
    createFailedMessage: t('errors.createBoardFailed'),
    expandFolder: workspaceTree.expandFolders,
    openBoard,
    refreshWorkspaceDocuments,
    setError,
    setFeedback,
    setSaving,
    successMessage: t('feedback.boardCreated'),
  })
  refreshWorkspaceDocumentsRef.current = refreshWorkspaceDocuments

  const templateDialogs = useWorkspaceTemplateDialogs({
    createDocument,
    selectedPlatform,
  })
  const { openDocumentTemplateDialog } = templateDialogs

  const rowActions = useWorkspaceTreeRowActions({
    deleteDocumentNode,
    renameWorkspaceNode,
  })

  const createFlows = useWorkspaceCreateFlows({
    createMenuFolder,
    createFolder,
    openTableFileWorkflow,
  })

  const workspaceMoveTargets = useMemo(
    () => workspaceTree.flatTreeNodes.filter(
      (node) => !node.virtual && (node.type === 'folder' || isEditableWorkspaceFormat(node.format)),
    ),
    [workspaceTree.flatTreeNodes],
  )

  const derivedState = useWorkspaceDerivedState({
    activeDocument,
    activeDocumentFormat,
    draftContent,
    editorLocked: editorView.locked,
    editorMode: editorView.editorMode,
    files,
    itemMenuOpen,
  })
  const {
    editorPreviewHtml,
    imageFiles,
    videoFiles,
  } = derivedState


  openDocumentTabRef.current = openDocumentTab
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
    agentBusySessions,
    agentDrafts,
    setAgentDraft,
    addAgentDocumentContext,
    activeWorkspaceDocumentPath,
    openDocument,
  })
  const { handleDocumentAskAgent } = chatEntryPoints

  const topbarActions = useWorkspaceTopbarActions({
    ensureActiveDocumentSaved,
    hasPendingRevision: Boolean(documentSession.activeDocumentRevision),
    activeDocument,
    activeDocumentFormat,
    restoreSavedVersion,
    replaceActiveDocumentText,
    editorLocked: editorView.locked,
    importInputRef,
    setEditorView,
    setError,
    setFeedback,
    setItemMenuOpen,
  })
  const {
    setEditorMode,
  } = topbarActions
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


  const { saveDocumentTitle } = useWorkspaceDocumentTitleRename({
    rootPath,
    activeDocument,
    activeDocumentFormat,
    activeResourcePath,
    treeState: workspaceTree,
    ensureActiveDocumentSaved,
    setAgentModifiedDocumentPaths,
    remapWorkspaceTabPaths,
    remapOpenedDocuments,
    setActiveResourcePath,
    setSaving,
    setError,
    setFeedback,
  })

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
      designEmptyState={design.chatEmptyState}
      kitionAccount={kitionAccount}
      kitionAccountLinks={kitionAccountLinks}
      onOpenSettingsSection={onOpenSettingsSection}
      onAddLocalSource={() => void agentComposer.addLocalAnalysisSource()}
      onSend={(sessionId, intent) => void agentComposer.sendMessage(sessionId, intent)}
      onOpenDocument={(path) => void openDocument(path)}
      onReviewModifiedArtifact={(path) => void openModifiedDocumentReview(path)}
      onImportFiles={(files, target) => importBrowserFiles(files, target)}
    />
  ) : null

  const { openSidebarPath } = useWorkspaceSidebarNavigation({
    workflowOpen,
    onCloseWorkflow,
    onCloseProfile,
    openDesign: design.open,
    openBoard,
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
    createDesign: design.create,
    kitCreations,
    openBoardTemplateDialog: boardCreation.openTemplateDialog,
    openWorkspaceWorkflow,
    openTableFileWorkflow,
    onCloseProfile,
  })

  const documentTranslation = useWorkspaceDocumentTranslation({
    model: selectedAgentModel,
    ensureHostedAccountReady,
    settings,
    setSettings,
    onOpenModelSettings: openModelSettings,
  })

  // The empty state's "New table": a table file from the Table kit, at the workspace root.
  const createTableFile = useCallback(() => {
    void kitCreations.find((kit) => kit.id === 'table')?.create('')
  }, [kitCreations])

  return (
    <>
      <WorkspaceScreenTopbar
        tabsPortal={topbarLeadingPortal}
        documentToolbarPortal={documentToolbarPortal}
        importInputRef={importInputRef}
        chrome={chrome}
        actions={topbarActions}
        derived={derivedState}
        documentSession={documentSession}
        tabs={{ workspaceTabs, activeWorkspaceTab, activeWorkspaceTabId, activateWorkspaceTab, closeTab: handleCloseWorkspaceTabById }}
        workflowOpen={workflowOpen}
        onCloseWorkflow={onCloseWorkflow}
        onCloseProfile={onCloseProfile}
        openExportDialog={openExportDialog}
        openWorkspaceFolder={openWorkspaceFolder}
      />
      <WorkspaceAgentChrome portal={topbarActionsPortal} panel={agentPanel} sessions={agentSessions} />
      <WorkspaceDialogs
        saving={saving}
        documentExport={documentExport}
        createFlows={createFlows}
        templateDialogs={templateDialogs}
        boardCreation={boardCreation}
      />
      <WorkspaceLayout
        sidebarWidth={effectiveSidebarWidth}
        rightPane={workspaceRightPane}
        rightPaneWidth={workspaceRightPane ? agentSidebarWidth : undefined}
        onResizeSidebar={handleWorkspaceSidebarResize}
        onResizeRightPane={handleAgentSidebarResize}
        editorClassName={cn(
          editorView.smallText && 'is-small-text',
          editorView.fullWidth && 'is-full-width',
          editorView.textStyle === 'serif' && 'is-serif',
          editorView.textStyle === 'mono' && 'is-mono',
        )}
        sidebar={
          <WorkspaceScreenSidebar
            tree={workspaceTree}
            treeNodes={workspaceTreeNodes}
            moveTargets={workspaceMoveTargets}
            activePath={activeResourcePath || activeDocument?.path || ''}
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
              documentSession,
              editorView,
              editorPreviewHtml,
              galleryPanelProps,
              agentPanel,
              activeAgentSession: activeWorkspaceAgentSession,
              agentBusySessions,
              stopAgentMessage,
              whiteboard: {
                available: whiteboardAgentAvailable,
                onBridgeChange: handleWhiteboardAgentBridgeChange,
                onGenerateImage: handleGenerateWhiteboardImage,
              },
              design: {
                available: designBridge.available,
                onBridgeChange: designBridge.handleBridgeChange,
                onGenerateImage: handleGenerateDesignImage,
              },
              templateDialogs,
              workflows: {
                openTableFileWorkflow,
                openWorkspaceWorkflow,
              },
              onCreateTable: createTableFile,
              onAskDocumentAgent: (request) => void handleDocumentAskAgent(request),
              documentTranslation,
              onAgentInsertionContextChange: handleAgentInsertionContextChange,
              onSaveDocumentTitle: saveDocumentTitle,
              onToolbarMount: handleDocumentToolbarMount,
              onSetEditorMode: setEditorMode,
            }}
          />
        )}
      />
    </>
  )
}
