/**
 * Composition root for the workspace window: sidebar tree, tab strip, editor
 * panes, browser panel, and the Agent sidebar. It owns tab state, create
 * flows, and the bridges that feed document, table, and whiteboard context to
 * the Agent. It is intentionally being split into focused hooks; do not add
 * new responsibilities here (see docs/superpowers/plans, Task 1.4).
 */
import { useWorkspaceDesign } from '../hooks/useWorkspaceDesign'
import { setInvalidationWorkspaceRoot } from '@/api/invalidation'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useKitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import { useKitableRegistration } from '@/features/workspace/hooks/useKitableRegistration'
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
import type { DataDocument } from '@/types/dataDocument'
import { WorkspaceEditorFrame, type WorkspaceKitableSidebarActions } from '@/features/workspace/components/WorkspaceEditorFrame'
import { FORM_SYNC_CHANGED_EVENT } from '@/features/formSync/api'
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
import { useWorkspaceBrowserPanel } from '@/features/workspace/hooks/useWorkspaceBrowserPanel'
import { useWorkspaceWorkflowCreateMode } from '@/features/workspace/hooks/useWorkspaceWorkflowCreateMode'
import { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'
import { useWorkspaceWhiteboardAgentBridge } from '@/features/workspace/hooks/useWorkspaceWhiteboardAgentBridge'
import { useWorkspaceDesignAgentBridge } from '@/features/workspace/hooks/useWorkspaceDesignAgentBridge'
import { useWorkspaceTableAgentContext } from '@/features/workspace/hooks/useWorkspaceTableAgentContext'
import { useWorkspaceAgentBrowserAutomation } from '@/features/workspace/hooks/useWorkspaceAgentBrowserAutomation'
import { useWorkspaceAgentTurnContext } from '@/features/workspace/hooks/useWorkspaceAgentTurnContext'
import { useWorkspaceKitableOpeners } from '@/features/workspace/hooks/useWorkspaceKitableOpeners'
import { useWorkspaceTreeRowActions } from '@/features/workspace/hooks/useWorkspaceTreeRowActions'
import { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import { useWorkspaceAgentPanel } from '@/features/workspace/hooks/useWorkspaceAgentPanel'
import { useWorkspaceAgentChatEntryPoints } from '@/features/workspace/hooks/useWorkspaceAgentChatEntryPoints'
import { useWorkspaceTabControllers } from '@/features/workspace/hooks/useWorkspaceTabControllers'
import { WorkspaceDialogs } from '@/features/workspace/components/WorkspaceDialogs'
import { WorkspaceAgentPane } from '@/features/workspace/components/WorkspaceAgentPane'
import { useWorkspaceSidebarNavigation } from '@/features/workspace/hooks/useWorkspaceSidebarNavigation'
import { useWorkspaceCreateMenu } from '@/features/workspace/hooks/useWorkspaceCreateMenu'
import { useWorkspaceBrowserTabEvents } from '@/features/workspace/hooks/useWorkspaceBrowserTabEvents'
import { useWorkspaceDocumentTitleRename } from '@/features/workspace/hooks/useWorkspaceDocumentTitleRename'
import { useWorkspaceAgentComposer } from '@/features/workspace/hooks/useWorkspaceAgentComposer'
import { useWorkspaceErrorNotice } from '@/features/workspace/hooks/useWorkspaceErrorNotice'
import { useWorkspaceDocumentTranslation } from '@/features/workspace/hooks/useWorkspaceDocumentTranslation'
import { useWorkspaceBoardCreation } from '@/features/workspace/hooks/useWorkspaceBoardCreation'
import { useWhiteboardImageGeneration } from '@/features/workspace/hooks/useWhiteboardImageGeneration'
import { setPinnedTabsWorkspace } from '@/features/document/editor/hooks/usePinnedTabs'
import { isEditableWorkspaceFormat } from '@/features/workspace/lib/workspace'
import { resolveAgentActiveDocument } from '@/features/workspace/lib/agentPaneContext'
import { resolveActiveKitablePath, resolveKitableSidebarMode } from '@/features/workspace/lib/activeKitable'
import { buildWorkspaceAgentTurnUpdate } from '@/features/workspace/lib/agentTurnUpdate'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { isDesktopRuntime, type WorkspaceDocument, type WorkspaceDocumentFormat } from '@/services/desktop'
import { WEB_BROWSER_ENABLED } from '@/lib/productFeatures'

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
  const kitableChildrenIndex = useKitableChildrenIndex(rootPath)
  const workspaceTreeNodes = useMemo(
    () => buildPrivateSectionTreeNodes(
      treeItems,
      treeMetadata,
      kitableChildrenIndex.tablesByKitablePath,
      kitableChildrenIndex.dashboardsByKitablePath,
      kitableChildrenIndex.workflowsByKitablePath,
    ),
    [
      treeItems,
      treeMetadata,
      kitableChildrenIndex.tablesByKitablePath,
      kitableChildrenIndex.dashboardsByKitablePath,
      kitableChildrenIndex.workflowsByKitablePath,
    ],
  )
  // Pinned tabs storage is workspace-scoped; keep the module-level current root
  // in sync with rootPath so pin/unpin/list operations hit the right bucket.
  useEffect(() => {
    setPinnedTabsWorkspace(rootPath)
    setInvalidationWorkspaceRoot(rootPath)
  }, [rootPath])
  useKitableRegistration(files, kitableChildrenIndex)
  const [error, setError] = useState('')
  const [, setFeedback] = useState('')
  // Group A: when the user picks "Create Workflow" from a kitable table
  // leaf's "..." menu, we surface a mode chooser (template vs AI). The dialog
  // can run scoped to a (documentId, tableId) pair OR entirely unbound
  // (delayed table binding). When context is non-null the user picked a leaf
  // table or a kitable with exactly one table; null signals "create a draft
  // — the user will pick the table inside the trigger config panel
  // afterwards". kitablePath, when set, controls where the resulting
  // workflow lands in the workspace tree.
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
  // The kition:workflow:changed bus (dispatched from features/workflow/api
  // on every patch/delete) drives a sidebar refresh so the per-kitable
  // workflow leaves stay in lockstep with the workflow list.
  useEffect(() => {
    function onWorkflowChanged() {
      void kitableChildrenIndex.refresh()
    }
    window.addEventListener('kition:workflow:changed', onWorkflowChanged)
    window.addEventListener(FORM_SYNC_CHANGED_EVENT, onWorkflowChanged)
    return () => {
      window.removeEventListener('kition:workflow:changed', onWorkflowChanged)
      window.removeEventListener(FORM_SYNC_CHANGED_EVENT, onWorkflowChanged)
    }
  }, [kitableChildrenIndex])
  const openDocumentTabRef = useRef<(document: WorkspaceDocument) => void>(
    () => {},
  )
  const openFileViewerTabRef = useRef<
    (path: string, format: WorkspaceDocumentFormat) => void
  >(() => {})
  const setActiveWorkspaceTabIdRef = useRef<(tabId: string) => void>(() => {})
  const workspaceTabsRef = useRef<typeof workspaceTabs>([])
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
  const agentBrowserEnabled = agentTurn.browserEnabled
  const setAgentBrowserEnabled = agentTurn.setBrowserEnabled
  const getAgentTaskMode = agentTurn.getTaskMode
  const handleAgentInsertionContextChange = agentTurn.handleInsertionContextChange
  const getAgentTurnContext = agentTurn.getTurnContext
  const prepareAgentBrowserContextForTurn = agentTurn.prepareBrowserContextForTurn
  const tableAgentRefreshRef = useRef<(() => Promise<void> | void) | null>(null)
  const documentSession = useWorkspaceDocumentSession({
    editorLocked: editorView.locked,
    editorMode: editorView.editorMode,
    files,
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
    activeResourcePath,
    applyWorkspaceDocument,
    autoSaveStatus,
    bumpEditorReset,
    clearActiveDocumentSession,
    draftContent,
    ensureActiveDocumentSaved,
    getOpenedDocumentDraftEntry,
    hasUnsavedChanges,
    openModifiedDocumentReview,
    openDocument,
    persistActiveDocument,
    pruneOpenedDocumentDrafts,
    remapOpenedDocumentDrafts,
    saving,
    selectedPlatform,
    setActiveResourcePath,
    setDraftContent,
    setSaving,
    setSelectedPlatform,
    snapshots,
    updateSnapshots,
    rememberDocumentSnapshot,
    reviewModifiedDocuments,
  } = documentSession

  const documentExport = useDocumentExport({
    activeDocument,
    activeDocumentFormat,
    draftContent,
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
    onTableMutated: async () => {
      await tableAgentRefreshRef.current?.()
    },
    onWhiteboardPatch: whiteboardBridge.receivePatch,
    onWhiteboardPatchCancelled: whiteboardBridge.cancelPreview,
    onDesignPatch: designBridge.receivePatch,
    onDesignPatchCancelled: designBridge.cancelPreview,
    prepareActiveDocument: ensureActiveDocumentSaved,
    getTurnContext: getAgentTurnContext,
    prepareBrowserContext: prepareAgentBrowserContextForTurn,
  })
  const {
    agentArtifacts,
    agentBusySessions,
    agentDrafts,
    agentEvents,
    agentLocalSources,
    agentModifiedDocumentPaths,
    agentSessions,
    agentToolCalls,
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
    updateWorkspaceTab,
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
    onCloseDocumentTab: (tab) => {
      const matchesActive = activeDocument?.path === tab.path
      console.warn('[KITION/close] tab=%s active=%s draftLen=%d hasUnsaved=%s',
        tab.path,
        activeDocument?.path || '(none)',
        draftContent.length,
        hasUnsavedChanges,
      )
      if (matchesActive) {
        void persistActiveDocument('shortcut').then((ok) => {
          console.warn('[KITION/close] persist resolved ok=%s path=%s', ok, tab.path)
        })
      }
      // Intentionally keep the draft cache: the save is async, and if the user
      // reopens the document immediately we need the latest input from cache;
      // otherwise the on-disk content is still stale and the input would appear lost.
    },
  })
  setActiveWorkspaceTabIdRef.current = setActiveWorkspaceTabId
  workspaceTabsRef.current = workspaceTabs

  // Closing a tab needs the workflow-route guard from the tab strip's
  // onClose: when the last workflow tab goes away, the full-screen
  // /workflow route has nothing left to scope to and should exit.
  // Shared between the tab strip's close button, the middle-click
  // shortcut, and the Cmd/Ctrl+W keyboard handler below.

  const activeBrowserTab =
    activeWorkspaceTab?.type === 'browser' ? activeWorkspaceTab : null
  agentTurn.setActiveBrowserTab(activeBrowserTab)


  const {
    openKitableTable,
    openKitableDashboard,
    openKitableWorkflow,
    openWorkspaceWorkflow,
    openBoard,
    openKitableContainer,
  } = useWorkspaceKitableOpeners({
    activeWorkspaceTab,
    kitableChildrenIndex,
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
    openKitableContainer,
    openBoard,
    openDocument,
  })

  const activeKitablePath = resolveActiveKitablePath(activeWorkspaceTab, activeDocumentFormat)
  const activeKitableMode = resolveKitableSidebarMode(activeWorkspaceTab, workflowOpen)

  const tableAgent = useWorkspaceTableAgentContext({ activeWorkspaceTab, activeBrowserTab })
  const {
    context: tableAgentContext,
    documentPath: tableAgentDocumentPath,
    activeDataWorkspaceTabPath,
    activeDataWorkspaceTableId,
    activeDataWorkspaceTabPathRef,
    browserResolvedTableId,
    lastTargetRef: lastTableAgentTargetRef,
  } = tableAgent
  tableAgentRefreshRef.current = tableAgentContext?.onTableChanged ?? null
  whiteboardBridge.setActiveBoardPath(activeWorkspaceTab?.type === 'board' ? activeWorkspaceTab.path : '')
  designBridge.setActiveDesignPath(activeWorkspaceTab?.type === 'design' ? activeWorkspaceTab.path : '')
  agentTurn.updateTurnContext(buildWorkspaceAgentTurnUpdate({
    activeWorkspaceTab,
    tableAgentContext,
    tableAgentDocumentPath,
    docIdByKitablePath: kitableChildrenIndex.docIdByKitablePath,
    browserResolvedTableId,
    activeDataWorkspaceTableId,
    browserEnabled: agentBrowserEnabled,
  }))
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
    agentArtifacts,
    agentBusySessions,
    agentToolCalls,
    available: whiteboardBridge.available,
    bridgesRef: whiteboardBridge.bridgesRef,
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

  const hasDocumentSnapshot = useCallback(
    (path: string) => snapshots.some((item) => item.path === path),
    [snapshots],
  )
  const treeActions = useWorkspaceTreeActions({
    activeDocument,
    activeResourcePath,
    applyWorkspaceDocument,
    clearActiveDocumentSession,
    filterWorkspaceTabs,
    hasDocumentSnapshot,
    hasUnsavedChanges,
    persistActiveDocument,
    pruneOpenedDocumentDrafts,
    rememberDocumentSnapshot,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    renameKitableChildrenIndexPath: kitableChildrenIndex.renameKitablePath,
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
    updateSnapshots,
  })
  const {
    createDocument,
    createDocumentInside,
    createFolder,
    createTable,
    createTableInsideKitable,
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
    createTable,
    selectedPlatform,
    kitableChildrenIndex,
    upsertWorkspaceTab,
    setActiveResourcePath,
    updateTreeMetadata: workspaceTree.updateTreeMetadata,
    setError,
    setFeedback,
  })
  const {
    documentTemplateDialogState,
    kitableTemplateDialogState,
    openDocumentTemplateDialog,
    closeDocumentTemplateDialog,
    openKitableTemplateDialog,
    closeKitableTemplateDialog,
    createDocumentFromTemplate: handleCreateDocumentFromTemplate,
    createKitableFromTemplate: handleCreateKitableFromTemplate,
  } = templateDialogs

  const rowActions = useWorkspaceTreeRowActions({
    workspaceTabs,
    activeWorkspaceTabId,
    upsertWorkspaceTab,
    kitableChildrenIndex,
    activeResourcePath,
    setActiveResourcePath,
    setError,
    setFeedback,
    deleteDocumentNode,
    renameWorkspaceNode,
  })
  const {
    renameKitableTableLeaf,
  } = rowActions

  // The mode chooser dialog runs against an optional (documentId, tableId)
  // pair. Two routing rules drive how callers reach this:
  //   - .kitable container row: look up the kitable's tables via the
  //     children index. 0 tables → surface an error (kitable has nothing
  //     for the workflow to react to yet). 1 table → open the mode
  //     dialog with that table as the pre-bound scope. 2+ tables → pass all
  //     table options into the dialog so the user chooses the trigger table
  //     before selecting a template.
  //   - virtual `table://` leaf: resolve the parent kitable + table from
  //     the leaf path and open the mode dialog with that scope (legacy
  //     entry, retained for callers that hand us a leaf node).
  const workflowCreateMode = useWorkspaceWorkflowCreateMode({
    kitableChildrenIndex,
    upsertWorkspaceTab,
    setActiveResourcePath,
    updateTreeMetadata: workspaceTree.updateTreeMetadata,
    setError,
  })
  const autoCreateModeState = workflowCreateMode.state
  const autoCreateModeBusyKind = workflowCreateMode.busyKind
  const autoCreateModeBusyTemplateId = workflowCreateMode.busyTemplateId
  const autoCreateModeError = workflowCreateMode.error
  const openWorkflowModeDialogForContext = workflowCreateMode.openForContext
  const openWorkflowCreateModeDialog = workflowCreateMode.openForTreeNode
  const createWorkflowFromKitableSidebar = workflowCreateMode.openForKitable
  const closeWorkflowCreateModeDialog = workflowCreateMode.close
  const handleWorkflowCreateModeSelect = workflowCreateMode.select

  const createFlows = useWorkspaceCreateFlows({
    activeWorkspaceTab,
    kitableChildrenIndex,
    createMenuFolder,
    createFolder,
    createTableInsideKitable,
    upsertWorkspaceTab,
    setActiveResourcePath,
    updateTreeMetadata: workspaceTree.updateTreeMetadata,
    openKitableDashboard,
    openKitableWorkflow,
    setError,
  })
  const {
    createTableFromKitableSidebar,
    createDashboardFromKitableSidebar,
    createFormFromKitableSidebar,
  } = createFlows

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

  const getBrowserTabOriginFallback = useCallback(() => ({
    documentPath: activeDataWorkspaceTabPathRef.current || lastTableAgentTargetRef.current.documentPath,
    tableId: lastTableAgentTargetRef.current.tableId,
    originLabel: lastTableAgentTargetRef.current.originLabel,
  }), [activeDataWorkspaceTabPathRef, lastTableAgentTargetRef])
  const getWorkspaceTabs = useCallback(() => workspaceTabsRef.current, [])
  useWorkspaceBrowserTabEvents({
    upsertWorkspaceTab,
    getTabs: getWorkspaceTabs,
    getOriginFallback: getBrowserTabOriginFallback,
  })

  const browserPanel = useWorkspaceBrowserPanel({
    activeBrowserTab,
    workspaceTabs,
    updateWorkspaceTab,
    workflowOpen,
    effectiveSidebarWidth,
    agentSidebarWidth,
    workspaceAgentOpen,
  })
  const {
    browserPanelPhase,
    setBrowserPanelPhase,
  } = browserPanel

  const workflowWorkbench = workflowOpen && workflowSchemaLookup ? (
    <div data-testid="workspace-workflow-workbench" className="h-full min-h-0 overflow-hidden bg-background">
      <Suspense fallback={null}>
        <WorkflowRoute
          workflowContext={workflowContext}
          schemaLookup={workflowSchemaLookup}
          scopedKitablePath={activeKitablePath || undefined}
          onExit={onCloseWorkflow}
          rootPath={rootPath}
        />
      </Suspense>
    </div>
  ) : null


  const agentBrowserAutomation = useWorkspaceAgentBrowserAutomation({
    activeWorkspaceAgentSession,
    agentEvents,
    agentBusySessions,
    sendAgentContextAction,
    activeBrowserTab,
    browserPanelPhase,
    setBrowserPanelPhase,
    setAgentBrowserEnabled,
    getTaskMode: getAgentTaskMode,
    tableAgentContext,
    tableAgentDocumentPath,
  })
  agentTurn.setPreflight(agentBrowserAutomation.runPreflight)


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
    activeDocument,
    activeDocumentFormat,
    applyWorkspaceDocument,
    bumpEditorReset,
    editorLocked: editorView.locked,
    importInputRef,
    setDraftContent,
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
    renameKitableChildrenIndexPath: kitableChildrenIndex.renameKitablePath,
    ensureActiveDocumentSaved,
    snapshots,
    updateSnapshots,
    setAgentModifiedDocumentPaths,
    remapWorkspaceTabPaths,
    remapOpenedDocumentDrafts,
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

  const handleTableFileImported = useCallback(async (path: string | undefined) => {
    await refreshWorkspaceDocuments(path, { silent: true, treeOnly: true })
    await kitableChildrenIndex.refresh()
    if (path) openKitableContainer(path)
  }, [kitableChildrenIndex, openKitableContainer, refreshWorkspaceDocuments])

  const { openSidebarPath } = useWorkspaceSidebarNavigation({
    kitableChildrenIndex,
    upsertWorkspaceTab,
    setActiveResourcePath,
    workflowOpen,
    onCloseWorkflow,
    onCloseProfile,
    openDesign: design.open,
    openBoard,
    openKitableContainer,
    openDocument,
  })

  const createMenuActions = useWorkspaceCreateMenu({
    createFlows,
    createMenuFolder,
    closeCreateMenu: () => workspaceTree.setCreateMenuOpen(false),
    openCreateFormatMenu,
    expandPrivateSection: () => setSidebarSectionsExpanded((current) => ({ ...current, private: true })),
    createDocumentInside,
    openDocumentTemplateDialog,
    openKitableTemplateDialog,
    createDesign: design.create,
    openBoardTemplateDialog: boardCreation.openTemplateDialog,
    openWorkspaceWorkflow,
    onCloseProfile,
  })

  const documentTranslation = useWorkspaceDocumentTranslation({
    model: selectedAgentModel,
    ensureHostedAccountReady,
    settings,
    setSettings,
    onOpenModelSettings: openModelSettings,
  })

  const kitableSidebarActions: WorkspaceKitableSidebarActions = {
    createDashboard: createDashboardFromKitableSidebar,
    createTable: createTableFromKitableSidebar,
    createForm: createFormFromKitableSidebar,
    createWorkflow: createWorkflowFromKitableSidebar,
    openDashboard: openKitableDashboard,
    openTable: openKitableTable,
    openWorkflow: openKitableWorkflow,
    renameTableLeaf: renameKitableTableLeaf,
  }

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
        workflowCreateMode={workflowCreateMode}
        onTableFileImported={handleTableFileImported}
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
            browserTabEnabled={WEB_BROWSER_ENABLED && isDesktopRuntime()}
            onCreateWorkflowForTable={openWorkflowCreateModeDialog}
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
            kitablePath={activeKitablePath}
            kitableMode={activeKitableMode}
            activeTab={activeWorkspaceTab}
            kitableChildrenIndex={kitableChildrenIndex}
            kitableActions={kitableSidebarActions}
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
              browserPanel,
              tableAgent,
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
              },
              templateDialogs,
              workflows: {
                createForKitable: createWorkflowFromKitableSidebar,
                openKitableWorkflow,
                openWorkspaceWorkflow,
              },
              onAskDocumentAgent: (request) => void handleDocumentAskAgent(request),
              documentTranslation,
              onAgentInsertionContextChange: handleAgentInsertionContextChange,
              onSaveDocumentTitle: saveDocumentTitle,
              onToolbarMount: handleDocumentToolbarMount,
              onSetEditorMode: setEditorMode,
              clearFeedback: () => setFeedback(''),
            }}
          />
        )}
      />
    </>
  )
}
