/**
 * Composition root for the workspace window: sidebar tree, tab strip, editor
 * panes, browser panel, and the Agent sidebar. It owns tab state, create
 * flows, and the bridges that feed document, table, and whiteboard context to
 * the Agent. It is intentionally being split into focused hooks; do not add
 * new responsibilities here (see docs/superpowers/plans, Task 1.4).
 */
import { useWorkspaceDesign } from '../hooks/useWorkspaceDesign'
import { flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'
import { setInvalidationWorkspaceRoot } from '@/api/invalidation'
import type { AgentImageGenerationIntent } from '@/types/imageGeneration'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useKitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import { useKitableRegistration } from '@/features/workspace/hooks/useKitableRegistration'
import {
  buildKitableTableVirtualPath,
  buildPrivateSectionTreeNodes,
  parseKitableDashboardVirtualPath,
  parseKitableWorkflowVirtualPath,
  parseKitableTableVirtualPath,
  renameWorkspaceTreeBranchMetadata,
  replaceWorkspaceTreeDocumentItem,
  updateWorkspaceTreeDocumentItem,
} from '@/features/workspace/lib/workspaceTree'
import { routeKitableOpenPath } from './workspaceScreenTabRouting'
import { renameDataDocumentByPath } from '@/api/dataDocuments'
import type { WorkflowRouteContext } from '@/features/workflow/public'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import { isKitionAccountSessionUsable } from '@/features/account/lib/accountState'
import {
  appendAgentLocalSource,
  buildActiveBrowserTabContext,
  extractAgentLocalPathReference,
  useWorkspaceAgent,
} from '@/features/agent/public'
import { useDocumentExport } from '@/features/document/hooks/useDocumentExport'
import { useWorkspaceDocumentSession } from '@/features/document/hooks/useWorkspaceDocumentSession'
import type { DocumentAskAgentRequest } from '@/features/document/lib/documentAgentActions'
import { AgentFloatingLauncher } from '@/features/agent/components/AgentFloatingLauncher'
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import type { DataDocument } from '@/types/dataDocument'
import { WorkspaceScreenEditor } from '@/features/workspace/components/WorkspaceScreenEditor'
import { WorkspaceKitableSidebar } from '@/features/workspace/components/WorkspaceKitableSidebar'
import { requestEmailSyncSetup } from '@/features/emailSync/public'
import { FORM_SYNC_CHANGED_EVENT } from '@/features/formSync/api'
import { WorkspaceAgentTabBar } from '@/features/workspace/components/WorkspaceAgentTabBar'
import {
  WorkspaceScreenSidebar,
  WorkspaceScreenSidebarFooter,
} from '@/features/workspace/components/WorkspaceScreenSidebar'
import { WorkspaceLayout } from '@/features/workspace/components/WorkspaceLayout'
import { WorkspaceTopbar } from '@/features/workspace/components/WorkspaceTopbar'
import {
  editorTextStyleOptions,
  useWorkspaceChrome,
} from '@/features/workspace/hooks/useWorkspaceChrome'
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
import { useWorkspaceTableAgentContext } from '@/features/workspace/hooks/useWorkspaceTableAgentContext'
import { useWorkspaceAgentBrowserAutomation } from '@/features/workspace/hooks/useWorkspaceAgentBrowserAutomation'
import { useWorkspaceAgentTurnContext } from '@/features/workspace/hooks/useWorkspaceAgentTurnContext'
import { useWorkspaceKitableOpeners } from '@/features/workspace/hooks/useWorkspaceKitableOpeners'
import { useWorkspaceTreeRowActions } from '@/features/workspace/hooks/useWorkspaceTreeRowActions'
import { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import { useWorkspaceAgentPanel } from '@/features/workspace/hooks/useWorkspaceAgentPanel'
import { useWorkspaceBoardCreation } from '@/features/workspace/hooks/useWorkspaceBoardCreation'
import { useWhiteboardImageGeneration } from '@/features/workspace/hooks/useWhiteboardImageGeneration'
import { setPinnedTabsWorkspace } from '@/features/document/editor/hooks/usePinnedTabs'
import {
  buildWorkspaceBrowserTabId,
  buildWorkspaceBrowserTabTitle,
  findWorkspaceBrowserTabIdsForSnapshot,
  OPEN_WORKSPACE_BROWSER_TAB_EVENT,
  resolveWorkspaceBrowserTabOrigin,
  type WorkspaceBrowserTabPayload,
} from '@/features/workspace/lib/browserTabs'
import {
  buildKitableWorkspaceTabId,
  formatWorkspaceTime,
  getKitableWorkspaceTabTitle,
  getWorkspaceItemTitle,
  inferWorkspaceItemFormat,
  isEditableWorkspaceFormat,
  remapWorkspaceBranchPath,
  renameWorkspaceDocumentPath,
  type WorkspaceMediaKind,
  type WorkspaceTreeNode,
} from '@/features/workspace/lib/workspace'
import {
  deriveAgentPaneContext,
  resolveAgentActiveDocument,
} from '@/features/workspace/lib/agentPaneContext'
import {
} from '@/features/workspace/lib/workspacePersistence'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import {
  chooseAgentAnalysisDirectory,
  isDesktopRuntime,
  moveWorkspaceDocument,
  openExternalURL,
  revealWorkspaceFolder,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
} from '@/services/desktop'
import { WEB_BROWSER_ENABLED } from '@/lib/productFeatures'

const WorkflowRoute = lazy(() =>
  import('@/features/workflow/pages/WorkflowRoute').then((module) => ({ default: module.WorkflowRoute })),
)
const DocumentExportDialog = lazy(() =>
  import('@/features/document/components/DocumentExportDialog').then((module) => ({ default: module.DocumentExportDialog })),
)
const DocumentTemplateLibraryDialog = lazy(() =>
  import('@/features/document/components/DocumentTemplateLibraryDialog').then((module) => ({ default: module.DocumentTemplateLibraryDialog })),
)
const KitableTemplateLibraryDialog = lazy(() =>
  import('@/features/table/components/KitableTemplateLibraryDialog').then((module) => ({ default: module.KitableTemplateLibraryDialog })),
)
const WhiteboardTemplateLibraryDialog = lazy(() =>
  import('@/features/whiteboard/components/WhiteboardTemplateLibraryDialog').then((module) => ({ default: module.WhiteboardTemplateLibraryDialog })),
)
const TableFileImportDialog = lazy(() =>
  import('@/features/table/components/TableFileImportDialog').then((module) => ({ default: module.TableFileImportDialog })),
)
const WorkspaceFolderCreateDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceFolderCreateDialog').then((module) => ({ default: module.WorkspaceFolderCreateDialog })),
)
const WorkspaceWorkflowCreateModeDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog').then((module) => ({ default: module.WorkspaceWorkflowCreateModeDialog })),
)
const FormSyncCreateDialog = lazy(() =>
  import('@/features/formSync/FormSyncCreateDialog').then((module) => ({ default: module.FormSyncCreateDialog })),
)
const WorkspaceAgentSidebar = lazy(() =>
  import('@/features/workspace/components/WorkspaceAgentSidebar').then((module) => ({ default: module.WorkspaceAgentSidebar })),
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
    createMenuOpen,
    createMenuTriggerPath,
    expandedPaths,
    files,
    loading,
    openCreateFormatMenu,
    rootPath,
    setWorkspaceItemIcon,
    toggleFolder,
    treeItems,
    treeMetadata,
    workspaceDisplayName,
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
    sidebarCollapsed,
    sidebarSectionsExpanded,
    toggleEditorPreference,
    toggleSidebarCollapsed,
    toggleSidebarSection,
  } = useWorkspaceChrome()
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
  const agentTurn = useWorkspaceAgentTurnContext({ buildWhiteboardContext: whiteboardBridge.buildActiveContext })
  const agentTurnContextRef = agentTurn.turnContextRef
  const agentBrowserEnabled = agentTurn.browserEnabled
  const setAgentBrowserEnabled = agentTurn.setBrowserEnabled
  const getAgentTaskMode = agentTurn.getTaskMode
  const handleAgentInsertionContextChange = agentTurn.handleInsertionContextChange
  const getAgentTurnContext = agentTurn.getTurnContext
  const prepareAgentBrowserContextForTurn = agentTurn.prepareBrowserContextForTurn
  const tableAgentRefreshRef = useRef<(() => Promise<void> | void) | null>(null)
  const {
    activeDocument,
    activeDocumentFormat,
    activeDocumentRevision,
    activeResourcePath,
    applyWorkspaceDocument,
    autoSaveStatus,
    bumpEditorReset,
    clearActiveDocumentSession,
    draftContent,
    documentRevisionSaving,
    decideDocumentRevisionChange,
    editorResetVersions,
    ensureActiveDocumentSaved,
    getOpenedDocumentDraftEntry,
    hasUnsavedChanges,
    handleDraftContentChange,
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
    resolveAllDocumentRevisionChanges,
  } = useWorkspaceDocumentSession({
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
    exportCurrentDocument,
    exportDialogOpen,
    exportFormat,
    exportIncludeMedia,
    exportPageFormat,
    exportScale,
    exporting,
    openExportDialog,
    pdfIncludeName,
    pdfLandscape,
    pdfMarginsType,
    setExportDialogOpen,
    setExportFormat,
    setExportIncludeMedia,
    setExportPageFormat,
    setExportScale,
    setPdfIncludeName,
    setPdfLandscape,
    setPdfMarginsType,
  } = useDocumentExport({
    activeDocument,
    activeDocumentFormat,
    draftContent,
    onError: setError,
    onFeedback: setFeedback,
  })
  const {
    agentArtifacts,
    agentBusySessions,
    agentDrafts,
    agentEvents,
    agentMessages,
    agentImageGenerationEvents,
    agentLocalSources,
    agentModelOptions,
    agentModifiedDocumentPaths,
    agentSessions,
    agentStreamingText,
    agentToolCalls,
    clearPendingFocusedSessionId,
    clearModifiedDocumentPath,
    createNewAgentChat,
    addAgentDocumentContext,
    addAgentLocalSource,
    handleAgentModelChange,
    mentionableDocuments,
    openAgentSession,
    pendingFocusedSessionId,
    refreshAgentSessions,
    removeAgentDocumentContext,
    resolvedAgentModelKey,
    resolveAgentDocumentContexts,
    removeAgentLocalSource,
    respondToAgentShellApproval,
    selectedAgentModel,
    sendAgentContextAction,
    sendAiComposerMessage,
    setAgentDraft,
    setAgentModifiedDocumentPaths,
    stopAgentMessage,
  } = useWorkspaceAgent({
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
    prepareActiveDocument: ensureActiveDocumentSaved,
    getTurnContext: getAgentTurnContext,
    prepareBrowserContext: prepareAgentBrowserContextForTurn,
  })
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
  const handleCloseWorkspaceTabById = useCallback((tabId: string) => {
    const tabs = workspaceTabsRef.current
    const closing = tabs.find((t) => t.id === tabId)
    if (!closing) return
    if (closing.type === 'design') {
      void flushWorkspaceEditSessions(closing.path)
        .then(() => closeWorkspaceTab(tabId))
        .catch(() => notify.error(t('design:errors.save')))
      return
    }
    closeWorkspaceTab(tabId)
    if (workflowOpen && closing.type === 'workflow') {
      const remainingWorkflow = tabs.some((t) => t.id !== tabId && t.type === 'workflow')
      if (!remainingWorkflow) onCloseWorkflow?.()
    }
  }, [closeWorkspaceTab, onCloseWorkflow, t, workflowOpen])

  // Cmd/Ctrl+W closes the active workspace tab. preventDefault avoids
  // the Electron / browser default of closing the window when the
  // shortcut bubbles up unhandled. No-op when there's no active tab
  // so empty workspaces don't swallow the key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'w') return
      const tabId = activeWorkspaceTabId
      if (!tabId) return
      event.preventDefault()
      handleCloseWorkspaceTabById(tabId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeWorkspaceTabId, handleCloseWorkspaceTabById])

  const activeBrowserTab =
    activeWorkspaceTab?.type === 'browser' ? activeWorkspaceTab : null
  agentTurn.setActiveBrowserTab(activeBrowserTab)

  // A scoped table/workflow tab belongs to its .kitable container. Keep the
  // primary workspace tree focused on that container; the Feishu-style inner
  // sidebar below owns table/workflow selection.
  useEffect(() => {
    if (!activeWorkspaceTab) return
    if (activeWorkspaceTab.type === 'table') {
      setActiveResourcePath(activeWorkspaceTab.kitablePath)
      return
    }
    if (activeWorkspaceTab.type === 'dashboard') {
      setActiveResourcePath(activeWorkspaceTab.kitablePath)
      return
    }
    if (activeWorkspaceTab.type === 'board' || activeWorkspaceTab.type === 'design') {
      setActiveResourcePath(activeWorkspaceTab.path)
      return
    }
    if (activeWorkspaceTab.type === 'workflow' && activeWorkspaceTab.kitablePath) {
      setActiveResourcePath(activeWorkspaceTab.kitablePath)
    }
  }, [activeWorkspaceTab, setActiveResourcePath])

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

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; vaultPath?: string }
      const path = detail?.path || detail?.vaultPath
      if (!path) {
        return
      }
      if (path.toLowerCase().endsWith('.kidesign')) { design.open(path); return }
      if (path.toLowerCase().endsWith('.kiboard')) {
        openBoard(path)
        return
      }
      void openDocument(path)
    }
    window.addEventListener('kition:search:open-path', handler)
    return () => window.removeEventListener('kition:search:open-path', handler)
  }, [design.open, openBoard, openDocument])

  const activeKitablePath = activeWorkspaceTab?.type === 'table'
    ? activeWorkspaceTab.kitablePath
    : activeWorkspaceTab?.type === 'dashboard'
      ? activeWorkspaceTab.kitablePath
    : activeWorkspaceTab?.type === 'workflow'
      ? activeWorkspaceTab.kitablePath || ''
      : activeWorkspaceTab?.type === 'document'
        && activeDocumentFormat === 'data'
        && activeWorkspaceTab.path.toLowerCase().endsWith('.kitable')
        ? activeWorkspaceTab.path
        : ''
  const activeKitableMode: 'dashboard' | 'table' | 'workflow' = workflowOpen || activeWorkspaceTab?.type === 'workflow'
    ? 'workflow'
    : activeWorkspaceTab?.type === 'dashboard'
      ? 'dashboard'
      : 'table'

  const tableAgent = useWorkspaceTableAgentContext({ activeWorkspaceTab, activeBrowserTab })
  const {
    context: tableAgentContext,
    documentPath: tableAgentDocumentPath,
    activeDataWorkspaceTabPath,
    activeDataWorkspaceTableId,
    activeDataWorkspaceTabPathRef,
    browserOriginDocumentPath,
    browserResolvedTableId,
    lastTargetRef: lastTableAgentTargetRef,
    handleContextChange: handleTableAgentContextChange,
  } = tableAgent
  tableAgentRefreshRef.current = tableAgentContext?.onTableChanged ?? null
  const agentActiveDocument = resolveAgentActiveDocument(activeWorkspaceTab)
  whiteboardBridge.setActiveBoardPath(activeWorkspaceTab?.type === 'board' ? activeWorkspaceTab.path : '')
  agentTurn.updateTurnContext({
    activeDocumentPath: agentActiveDocument.path,
    activeDocumentFormat: agentActiveDocument.format,
    activeDocument: tableAgentContext?.activeDocument,
    activeTable: tableAgentContext?.activeTable,
    activeDataDocumentId: Number(
      tableAgentDocumentPath
        ? kitableChildrenIndex.docIdByKitablePath[tableAgentDocumentPath]
        : 0,
    ) || 0,
    activeDataTableId: activeWorkspaceTab?.type === 'browser'
      ? browserResolvedTableId
      : activeDataWorkspaceTableId,
    browserContext: activeBrowserTab
      ? buildActiveBrowserTabContext({
          provider: activeBrowserTab.provider,
          host: activeBrowserTab.host,
          url: activeBrowserTab.url,
          title: activeBrowserTab.title,
        })
      : undefined,
    browserEnabled: agentBrowserEnabled,
    // Same mapping as AgentChatPanel.paneContext (empty-state copy) so
    // the agent's system prompt addendum matches what the user sees on
    // the empty-state card. Browser pane is implicit when an
    // activeBrowserTab is set, but we also pass it explicitly so the
    // mapping doesn't silently desync between the two surfaces.
    paneContext: deriveAgentPaneContext(activeWorkspaceTab),
    // When the workflow tab carries a specific workflowId (the user
    // drilled into one via the file tree leaf or the picker), forward
    // it so the backend can attach the active-workflow summary to the
    // skill context. Empty / undefined when the tab is the global
    // workflow list, which is fine — the backend skips the addendum.
    activeWorkflowId: activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.workflowId : undefined,
  })
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
    historyOpen: workspaceAgentHistoryOpen,
    setHistoryOpen: setWorkspaceAgentHistoryOpen,
    activeSessionId: activeWorkspaceAgentSessionId,
    setActiveSessionId: setActiveWorkspaceAgentSessionId,
    activeSession: activeWorkspaceAgentSession,
    openSessions: openWorkspaceAgentSessions,
    toggle: toggleActiveAgentPanel,
    createChat: handleCreateWorkspaceAgentChat,
    showSession: handleWorkspaceAgentSessionSelect,
    closeSessions: handleCloseWorkspaceAgentChats,
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
  const {
    createDocument,
    createDocumentInside,
    createFolder,
    createTable,
    createTableInsideKitable,
    deleteDocumentNode,
    dropWorkspaceNode,
    duplicateDocumentNode,
    importBrowserFiles,
    moveWorkspaceNodeToFolder,
    openWorkspaceFolder,
    refreshWorkspaceDocuments,
    renameWorkspaceNode,
  } = useWorkspaceTreeActions({
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
    documentEditorFocusRequest,
    openDocumentTemplateDialog,
    closeDocumentTemplateDialog,
    openKitableTemplateDialog,
    closeKitableTemplateDialog,
    createDocumentFromTemplate: handleCreateDocumentFromTemplate,
    createKitableFromTemplate: handleCreateKitableFromTemplate,
  } = templateDialogs

  const {
    handleTreeNodeDelete,
    handleTreeNodeRename,
    renameKitableTableLeaf,
  } = useWorkspaceTreeRowActions({
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
    folderDialogOpen: workspaceFolderDialogOpen,
    folderName: workspaceFolderName,
    setFolderName: setWorkspaceFolderName,
    tableFileImportState,
    tableFileImportInputRef,
    kitableCreateContext,
    setKitableCreateContext,
    createMenuVariant,
    createTableFromKitableSidebar,
    createDashboardFromKitableSidebar,
    createFormFromKitableSidebar,
    formSyncCreateState,
    handleFormSyncCreated,
  } = createFlows

  const workspaceMoveTargets = useMemo(
    () => workspaceTree.flatTreeNodes.filter(
      (node) => !node.virtual && (node.type === 'folder' || isEditableWorkspaceFormat(node.format)),
    ),
    [workspaceTree.flatTreeNodes],
  )

  const {
    activeItemWordCount,
    canImportSource,
    editorPreviewHtml,
    imageFiles,
    videoFiles,
  } = useWorkspaceDerivedState({
    activeDocument,
    activeDocumentFormat,
    draftContent,
    editorLocked: editorView.locked,
    editorMode: editorView.editorMode,
    files,
    itemMenuOpen,
  })

  function openDocumentTab(document: WorkspaceDocument) {
    const format = inferWorkspaceItemFormat(document.path, document.content)
    if (format === 'design') { design.open(document.path); return }
    if (format === 'data' && document.path.toLowerCase().endsWith('.kitable')) {
      openKitableContainer(document.path)
      return
    }
    upsertWorkspaceTab({
      id: `document:${document.path}`,
      type: 'document',
      title: getWorkspaceItemTitle(document.name),
      path: document.path,
      format,

      uid: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    })
  }
  openDocumentTabRef.current = openDocumentTab

  function openFileViewerTab(path: string, format: WorkspaceDocumentFormat) {
    if (path.toLowerCase().endsWith('.kidesign')) { design.open(path); return }
    const filename = String(path || '').split('/').filter(Boolean).pop() || path
    upsertWorkspaceTab({
      id: `file-viewer:${path}`,
      type: 'file-viewer',
      title: getWorkspaceItemTitle(filename),
      path,
      format,
    })
  }
  openFileViewerTabRef.current = openFileViewerTab

  useEffect(() => {
    const handleOpenBrowserTab = (event: Event) => {
      if (!WEB_BROWSER_ENABLED) {
        return
      }
      const detail = (event as CustomEvent<WorkspaceBrowserTabPayload>).detail
      if (!detail?.provider) {
        return
      }
      const resolvedOrigin = resolveWorkspaceBrowserTabOrigin(detail, {
        documentPath:
          activeDataWorkspaceTabPathRef.current ||
          lastTableAgentTargetRef.current.documentPath,
        tableId: lastTableAgentTargetRef.current.tableId,
        originLabel: lastTableAgentTargetRef.current.originLabel,
      })
      const snapshot = {
        ...detail,
        origin_tab_id: resolvedOrigin.originTabId,
        origin_document_path: resolvedOrigin.originDocumentPath,
        origin_table_id: resolvedOrigin.originTableId,
        origin_label: resolvedOrigin.originLabel,
      }
      const matchedIds = findWorkspaceBrowserTabIdsForSnapshot(
        workspaceTabsRef.current,
        snapshot,
      )
      upsertWorkspaceTab({
        id: matchedIds[0] || buildWorkspaceBrowserTabId(snapshot),
        type: 'browser',
        title: buildWorkspaceBrowserTabTitle({
          ...detail,
          origin_label: resolvedOrigin.originLabel,
        }),
        provider: detail.provider,
        taskMode:
          detail.task_mode === 'auto' ||
          detail.task_mode === 'browse' ||
          detail.task_mode === 'table'
            ? detail.task_mode
            : undefined,
        host: detail.host,
        url: detail.url,
        query: detail.query,
        profileId: detail.profile_id,
        originTabId: resolvedOrigin.originTabId || undefined,
        originDocumentPath: resolvedOrigin.originDocumentPath || undefined,
        originTableId:
          typeof resolvedOrigin.originTableId === 'number'
            ? resolvedOrigin.originTableId
            : undefined,
        originLabel: resolvedOrigin.originLabel || undefined,
      }, {
        activate: detail.activate !== false,
        insertAfterActive: detail.insertAfterActive !== false,
      })
    }

    window.addEventListener(
      OPEN_WORKSPACE_BROWSER_TAB_EVENT,
      handleOpenBrowserTab as EventListener,
    )

    return () => {
      window.removeEventListener(
        OPEN_WORKSPACE_BROWSER_TAB_EVENT,
        handleOpenBrowserTab as EventListener,
      )
    }
  }, [upsertWorkspaceTab])

  const {
    browserPanelPhase,
    setBrowserPanelPhase,
    browserToolbarStatus,
    handleBrowserNavigate,
    handleBrowserBack,
    handleBrowserForward,
    handleBrowserReload,
    handleBrowserStop,
  } = useWorkspaceBrowserPanel({
    activeBrowserTab,
    workspaceTabs,
    updateWorkspaceTab,
    workflowOpen,
    effectiveSidebarWidth,
    agentSidebarWidth,
    workspaceAgentOpen,
  })

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


  async function handleDocumentAskAgent(request: DocumentAskAgentRequest) {
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)

    let sessionId = activeWorkspaceAgentSession?.id ?? null
    const shouldCreateSession = !sessionId
      || agentBusySessions.has(sessionId)
      || Boolean(agentDrafts[sessionId]?.trim())
    if (shouldCreateSession) {
      const session = await createNewAgentChat({
        focusTab: true,
        documentPaths: request.documentPath ? [request.documentPath] : [],
      })
      sessionId = session?.id ?? null
      if (sessionId) {
        setActiveWorkspaceAgentSessionId(sessionId)
      }
    } else if (sessionId && request.documentPath) {
      addAgentDocumentContext(sessionId, request.documentPath, activeWorkspaceDocumentPath)
    }
    if (!sessionId) return

    setAgentDraft(sessionId, request.prompt)
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
    })
  }

  useEffect(() => {
    function startOnboardingAgent(event: Event) {
      const detail = (event as CustomEvent<{ documentPath?: string; prompt?: string }>).detail
      const documentPath = String(detail?.documentPath || '').trim()
      const prompt = String(detail?.prompt || '').trim()
      void (async () => {
        if (documentPath) {
          await openDocument(documentPath)
        }
        setWorkspaceAgentOpen(true)
        setWorkspaceAgentHistoryOpen(false)
        const session = await createNewAgentChat({
          focusTab: true,
          documentPaths: documentPath ? [documentPath] : [],
        })
        if (!session?.id) return
        setActiveWorkspaceAgentSessionId(session.id)
        if (prompt) {
          setAgentDraft(session.id, prompt)
        }
        window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
      })()
    }
    window.addEventListener('kition:onboarding:start-agent', startOnboardingAgent)
    return () => window.removeEventListener('kition:onboarding:start-agent', startOnboardingAgent)
  }, [createNewAgentChat, openDocument, setAgentDraft])

  async function attachNodeMentionToAgentChat(
    node: WorkspaceTreeNode,
    { forceNew }: { forceNew: boolean },
  ) {
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)

    let sessionId = forceNew ? null : activeWorkspaceAgentSession?.id ?? null
    if (!sessionId) {
      const session = await createNewAgentChat({
        focusTab: true,
        documentPaths: [node.path],
      })
      sessionId = session?.id ?? null
      if (sessionId) {
        setActiveWorkspaceAgentSessionId(sessionId)
      }
    }
    if (!sessionId) {
      return
    }

    if (!forceNew) {
      addAgentDocumentContext(sessionId, node.path, activeWorkspaceDocumentPath)
    }

    window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
  }

  async function addNodeToWorkspaceAgentChat(node: WorkspaceTreeNode) {
    await attachNodeMentionToAgentChat(node, { forceNew: false })
  }

  async function addNodeToNewWorkspaceAgentChat(node: WorkspaceTreeNode) {
    await attachNodeMentionToAgentChat(node, { forceNew: true })
  }

  // Consumer for the workflow Ask-AI bridge. NodeCard's hover pill dispatches
  // kition:workflow-node:ask-ai with a typed payload (workflow/node ids,
  // current config, table schema). We mirror addNodeToWorkspaceAgentChat —
  // open the agent panel, ensure a session, then prepend the pre-rendered
  // prompt as the session draft. The publisher lives in features/workflow;
  // we keep the consumer here because session state isn't lifted any higher.
  const askAIPromptBuilderRef = useRef<((payload: any) => string) | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('@/features/workflow/lib/askAiBridge').then((mod) => {
      if (!cancelled) askAIPromptBuilderRef.current = mod.buildWorkflowNodeAskAIPrompt
    })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    async function handler(event: Event) {
      const detail = (event as CustomEvent).detail
      if (!detail) return
      setWorkspaceAgentOpen(true)
      setWorkspaceAgentHistoryOpen(false)
      let sessionId = activeWorkspaceAgentSession?.id ?? null
      if (!sessionId) {
        const session = await createNewAgentChat({ focusTab: true })
        sessionId = session?.id ?? null
        if (sessionId) setActiveWorkspaceAgentSessionId(sessionId)
      }
      if (!sessionId) return
      const build = askAIPromptBuilderRef.current
      const prompt = build ? build(detail) : `Help me with the ${detail.nodeKind} node ${detail.nodeId} of workflow ${detail.workflow?.name}.`
      const current = agentDrafts[sessionId] || ''
      const separator = current && !/\s$/.test(current) ? '\n\n' : ''
      setAgentDraft(sessionId, `${current}${separator}${prompt}`)
    }
    window.addEventListener('kition:workflow-node:ask-ai', handler as EventListener)
    return () => {
      window.removeEventListener('kition:workflow-node:ask-ai', handler as EventListener)
    }
  }, [
    activeWorkspaceAgentSession?.id,
    agentDrafts,
    createNewAgentChat,
    setActiveWorkspaceAgentSessionId,
    setAgentDraft,
    setWorkspaceAgentHistoryOpen,
    setWorkspaceAgentOpen,
  ])

  // Sibling of the Ask-AI listener: AI workflow generation publishes
  // kition:workflow-ai-build:open when WorkflowHomePage mounts in
  // build-streaming mode. We open the agent panel and seed the composer with
  // the user's initial prompt so the chat surface is immediately useful for
  // follow-ups while the SSE stream paints nodes onto the canvas.
  useEffect(() => {
    async function handler(event: Event) {
      const detail = (event as CustomEvent).detail as { prompt?: string; workflow?: { name?: string }; tableName?: string } | undefined
      if (!detail || !detail.prompt) return
      setWorkspaceAgentOpen(true)
      setWorkspaceAgentHistoryOpen(false)
      let sessionId = activeWorkspaceAgentSession?.id ?? null
      if (!sessionId) {
        const session = await createNewAgentChat({ focusTab: true })
        sessionId = session?.id ?? null
        if (sessionId) setActiveWorkspaceAgentSessionId(sessionId)
      }
      if (!sessionId) return
      // Only seed when the composer is empty so we don't clobber whatever the
      // user typed manually between event dispatch and listener resolution.
      const current = agentDrafts[sessionId] || ''
      if (current.trim()) return
      setAgentDraft(sessionId, detail.prompt)
    }
    window.addEventListener('kition:workflow-ai-build:open', handler as EventListener)
    return () => {
      window.removeEventListener('kition:workflow-ai-build:open', handler as EventListener)
    }
  }, [
    activeWorkspaceAgentSession?.id,
    agentDrafts,
    createNewAgentChat,
    setActiveWorkspaceAgentSessionId,
    setAgentDraft,
    setWorkspaceAgentHistoryOpen,
    setWorkspaceAgentOpen,
  ])


  const {
    importMarkdownFile,
    restoreSavedDraft,
    runActiveDataTableAction,
    setEditorMode,
  } = useWorkspaceTopbarActions({
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
  const { agentNeedsModelConfig, galleryPanelProps } =
    useWorkspaceEditorPanels({
      activeWorkspaceTab,
      error,
      imageFiles,
      onOpenDocument: openDocument,
      videoFiles,
    })

  useEffect(() => {
    const id = 'workspace-error'
    if (!error) {
      notify.dismiss(id)
      return
    }
    if (agentNeedsModelConfig && onOpenSettingsSection) {
      notify.persistentError(error, {
        label: 'Configure',
        onClick: () => onOpenSettingsSection('models'),
      }, { id })
    } else {
      notify.error(error, { id })
    }
  }, [error, agentNeedsModelConfig, onOpenSettingsSection])

  function openGalleryTab(kind: WorkspaceMediaKind) {
    if (kind === 'images') {
      return
    }
    upsertWorkspaceTab({
      id: `gallery:${kind}`,
      type: 'gallery',
      title: t('tabs.videos'),
      kind,
    })
    setSidebarSectionsExpanded((current) => ({ ...current, [kind]: true }))
    setActiveResourcePath('')
    setError('')
    setFeedback('')
  }

  const renameActiveWorkspaceDocument = useCallback(async ({
    path,
    title,
  }: {
    path: string
    title: string
  }) => {
    const nextTitle = String(title || '').trim()
    if (!path) {
      throw new Error(t('errors.documentPathEmpty'))
    }
    if (!nextTitle) {
      throw new Error(t('errors.nameEmpty'))
    }

    const targetPath = renameWorkspaceDocumentPath(path, nextTitle)
    if (!targetPath || targetPath === path) {
      const currentDocument = activeDocument?.path === path ? activeDocument : null
      return currentDocument || {
        path,
        name: path.split('/').pop() || path,
        content: '',
      }
    }

    const shouldSaveActiveDocument = remapWorkspaceBranchPath(activeDocument?.path || '', path, targetPath) !== (activeDocument?.path || '')
    if (shouldSaveActiveDocument) {
      const saved = await ensureActiveDocumentSaved()
      if (!saved) {
        throw new Error(t('errors.saveBeforeRename'))
      }
    }

    const targetFolder = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : ''
    const targetName = targetPath.split('/').pop() || targetPath
    const draggedNode = workspaceTree.flatTreeNodes.find((node) => node.path === path)

    setSaving(true)
    setError('')
    setFeedback('')

    try {
      const movedDocument = await moveWorkspaceDocument({
        path,
        target_folder: targetFolder,
        target_name: targetName,
      })

      // Keep the DataDocument row's path in sync with the on-disk file —
      // without this, listDocuments would keep trying to open the old path.
      // Also rekey the kitable children index so the tree's table/workflow
      // leaves don't briefly disappear before the next backend refresh.
      // Best-effort: a failure here mustn't roll back the disk rename.
      if (path !== movedDocument.path && path.toLowerCase().endsWith('.kitable')) {
        kitableChildrenIndex.renameKitablePath(path, movedDocument.path)
        renameDataDocumentByPath({ path, target_path: movedDocument.path, workspace_root: rootPath })
          .catch((cleanupError) => {
            console.warn('[workspace] failed to sync kitable backend index', cleanupError)
          })
      }

      if (draggedNode) {
        workspaceTree.updateTreeMetadata((current) => (
          renameWorkspaceTreeBranchMetadata(
            current,
            workspaceTree.flatTreeNodes,
            draggedNode,
            movedDocument.path,
          )
        ))
      }

      workspaceTree.setTreeItems((current) => (
        replaceWorkspaceTreeDocumentItem(current, path, movedDocument)
      ))

      updateSnapshots(
        snapshots.map((snapshot) => {
          const nextPath = remapWorkspaceBranchPath(snapshot.path, path, movedDocument.path)
          if (nextPath === snapshot.path) {
            return snapshot
          }

          return {
            ...snapshot,
            path: nextPath,
            name: nextPath === movedDocument.path ? movedDocument.name : nextPath.split('/').pop() || snapshot.name,
          }
        }),
      )
      setAgentModifiedDocumentPaths((current) => {
        const next = new Set<string>()
        current.forEach((itemPath) => next.add(remapWorkspaceBranchPath(itemPath, path, movedDocument.path)))
        return next
      })

      remapWorkspaceTabPaths(path, movedDocument.path)
      remapOpenedDocumentDrafts(path, movedDocument.path)

      if (activeResourcePath) {
        const nextResourcePath = remapWorkspaceBranchPath(activeResourcePath, path, movedDocument.path)
        if (nextResourcePath !== activeResourcePath) {
          setActiveResourcePath('')
        }
      }

      setFeedback(t('feedback.nameUpdated'))
      return movedDocument
    } catch (requestError: any) {
      const message = requestError?.message || t('errors.renameFailed')
      setError(message)
      throw new Error(message)
    } finally {
      setSaving(false)
    }
  }, [
    activeDocument,
    activeResourcePath,
    ensureActiveDocumentSaved,
    remapOpenedDocumentDrafts,
    remapWorkspaceTabPaths,
    setAgentModifiedDocumentPaths,
    setActiveResourcePath,
    setError,
    setFeedback,
    setSaving,
    snapshots,
    updateSnapshots,
    workspaceTree,
    t,
  ])

  async function saveDocumentTitle(nextTitleInput: string) {
    if (!activeDocument || activeDocumentFormat === 'data') {
      return
    }

    const currentTitle = getWorkspaceItemTitle(activeDocument.name)
    const nextTitle = nextTitleInput.trim() || currentTitle
    if (nextTitle === currentTitle) {
      return
    }

    const targetPath = renameWorkspaceDocumentPath(activeDocument.path, nextTitle)
    const targetName = targetPath.split('/').pop() || activeDocument.name
    workspaceTree.setTreeItems((current) => updateWorkspaceTreeDocumentItem(current, {
      ...activeDocument,
      name: targetName,
    }))

    try {
      await renameActiveWorkspaceDocument({
        path: activeDocument.path,
        title: nextTitle,
      })
    } catch {
      workspaceTree.setTreeItems((current) => updateWorkspaceTreeDocumentItem(current, activeDocument))
    }
  }

  async function reviewAgentModifiedDocument(path: string) {
    await openModifiedDocumentReview(path)
  }

  async function addLocalAnalysisSource(suggestedPath = '') {
    if (!activeWorkspaceAgentSession) {
      return null
    }
    try {
      const source = await chooseAgentAnalysisDirectory(suggestedPath)
      if (source) {
        addAgentLocalSource(activeWorkspaceAgentSession.id, source)
      }
      return source
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to select an analysis folder')
      return null
    }
  }

  async function sendWorkspaceAgentMessage(sessionId: number, imageIntent?: AgentImageGenerationIntent) {
    const sources = agentLocalSources[sessionId] || []
    const pathReference = extractAgentLocalPathReference(agentDrafts[sessionId] || '')
    if (!sources.length && pathReference) {
      const source = await addLocalAnalysisSource(pathReference)
      if (!source) {
        return
      }
      sendAiComposerMessage(sessionId, appendAgentLocalSource(sources, source), imageIntent)
      return
    }
    sendAiComposerMessage(sessionId, undefined, imageIntent)
  }

  const workspaceRightPane = workspaceAgentOpen ? (
    <Suspense fallback={null}>
      <WorkspaceAgentSidebar
        rootPath={rootPath}
        imageContext={agentTurnContextRef.current}
        imageEvents={agentImageGenerationEvents[activeWorkspaceAgentSession?.id || 0] || []}
        panelProps={
          activeWorkspaceAgentSession
            ? {
              session: activeWorkspaceAgentSession,
              messages:
                agentMessages[activeWorkspaceAgentSession.id] || [],
              toolCalls:
                agentToolCalls[activeWorkspaceAgentSession.id] || [],
              events: agentEvents[activeWorkspaceAgentSession.id] || [],
              draft: agentDrafts[activeWorkspaceAgentSession.id] || '',
              streamingText:
                agentStreamingText[activeWorkspaceAgentSession.id] || '',
              artifacts:
                agentArtifacts[activeWorkspaceAgentSession.id] || [],
              busy: agentBusySessions.has(activeWorkspaceAgentSession.id),
              currentDocumentPath: activeWorkspaceDocumentPath,
              modelOptions: agentModelOptions,
              selectedModelKey: resolvedAgentModelKey,
              needsModelConfig: !selectedAgentModel?.runtimeModel,
              hostedAccountStatus: selectedAgentModel?.providerKind === 'kition_console'
                ? kitionAccount.state.status
                : undefined,
              mentionableDocuments,
              documentContextPaths: activeAgentDocumentContextPaths,
              localSources: agentLocalSources[activeWorkspaceAgentSession.id] || [],
              formatTime: formatWorkspaceTime,
              onDraftChange: (value: string) =>
                setAgentDraft(activeWorkspaceAgentSession.id, value),
              onAddLocalSource: () => void addLocalAnalysisSource(),
              onAddDocumentContext: (path: string) => addAgentDocumentContext(
                activeWorkspaceAgentSession.id,
                path,
                activeWorkspaceDocumentPath,
              ),
              onRemoveDocumentContext: (path: string) => removeAgentDocumentContext(
                activeWorkspaceAgentSession.id,
                path,
              ),
              onRemoveLocalSource: (sourceId: string) => removeAgentLocalSource(
                activeWorkspaceAgentSession.id,
                sourceId,
              ),
              onSend: (intent) => void sendWorkspaceAgentMessage(activeWorkspaceAgentSession.id, intent),
              onStop: () => stopAgentMessage(activeWorkspaceAgentSession.id),
              onConfigureModel: onOpenSettingsSection
                ? () => onOpenSettingsSection('models')
                : () => {},
              onHostedAccountConnect: () => void kitionAccount.ensureReady(),
              onHostedAccountCancel: kitionAccount.cancelConnect,
              onHostedAccountBilling: () => void openExternalURL(kitionAccountLinks.topup),
              onModelChange: (value: string) =>
                void handleAgentModelChange(value),
              onOpenArtifact: (path: string) => void openDocument(path),
              onReviewModifiedArtifact: (path: string) => void reviewAgentModifiedDocument(path),
              onShellApprovalDecision: (request, decision) => respondToAgentShellApproval(
                activeWorkspaceAgentSession.id,
                request,
                decision,
              ),
              onImportFiles: isDesktopRuntime()
                ? (files) => importBrowserFiles(files, 'attachments')
                : undefined,
              onApplyPlan: (plan) =>
                sendAgentContextAction(activeWorkspaceAgentSession.id, {
                  content:
                    'Please execute the current write task directly using the confirmed table plan, writing the rows to the table now.',
                  executionMode: 'apply',
                  tablePlanContext: plan,
                }),
              // Map the active tab type to the agent panel's empty-state
              // variant so a freshly-opened workflow editor doesn't get
              // the "Summarize this document" CTAs. The agent itself is
              // pane-agnostic; this only changes what the user sees
              // BEFORE they send their first message.
              paneContext: deriveAgentPaneContext(activeWorkspaceTab),
              emptyStateOverride: activeWorkspaceTab?.type === 'design' ? design.chatEmptyState : undefined,
              }
            : null
        }
      />
    </Suspense>
  ) : null

  return (
    <>
      <WorkspaceTopbar
        tabsPortal={topbarLeadingPortal}
        documentToolbarPortal={activeWorkspaceTab?.type === 'document' ? documentToolbarPortal : null}
        tabStripProps={{
          tabs: workspaceTabs,
          activeTabId: activeWorkspaceTabId,
          onActivate: (tab) => {
            onCloseProfile?.()
            // The full-screen WorkflowRoute is gated on the URL (/workflow*),
            // so switching to a non-workflow tab without exiting the route
            // would leave WorkflowRoute covering the chosen document.
            if (workflowOpen && tab.type !== 'workflow') {
              onCloseWorkflow?.()
            }
            activateWorkspaceTab(tab)
          },
          onClose: handleCloseWorkspaceTabById,
          onCloseOthers: (tabId) => {
            workspaceTabs
              .filter((tab) => tab.id !== tabId)
              .forEach((tab) => handleCloseWorkspaceTabById(tab.id))
            const keeper = workspaceTabs.find((t) => t.id === tabId)
            if (workflowOpen && keeper && keeper.type !== 'workflow') {
              onCloseWorkflow?.()
            }
          },
          onCloseAll: () => {
            workspaceTabs.forEach((tab) => handleCloseWorkspaceTabById(tab.id))
            if (workflowOpen) onCloseWorkflow?.()
          },
          onCloseUnmodified: () => {
            workspaceTabs.forEach((tab) => {
              if (tab.type === 'document') {
                const modified = tab.path === activeDocument?.path
                  ? hasUnsavedChanges
                  : getOpenedDocumentDraftEntry(tab.path) !== null
                if (modified) {
                  return
                }
              }
              handleCloseWorkspaceTabById(tab.id)
            })
          },
          onCloseLeft: (tabId) => {
            const index = workspaceTabs.findIndex((tab) => tab.id === tabId)
            if (index <= 0) {
              return
            }
            workspaceTabs
              .slice(0, index)
              .forEach((tab) => handleCloseWorkspaceTabById(tab.id))
          },
          onCloseRight: (tabId) => {
            const index = workspaceTabs.findIndex((tab) => tab.id === tabId)
            if (index < 0) {
              return
            }
            workspaceTabs
              .slice(index + 1)
              .forEach((tab) => handleCloseWorkspaceTabById(tab.id))
          },
          onCloseReadOnly: () => {
            workspaceTabs.forEach((tab) => {
              if (
                tab.type === 'file-viewer'
                || tab.type === 'gallery'
                || tab.type === 'browser-sites'
              ) {
                handleCloseWorkspaceTabById(tab.id)
              }
            })
          },
          onCopyTabRef: (tab) => {
            const text = tab.type === 'document'
              ? tab.path
              : tab.type === 'file-viewer'
                ? tab.path
                : tab.type === 'browser'
                  ? tab.url || tab.title
                  : tab.title
            if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
              void navigator.clipboard.writeText(text)
            }
          },
          isTabModified: (tab) => {
            if (tab.type !== 'document') {
              return false
            }
            return tab.path === activeDocument?.path
              ? hasUnsavedChanges
              : getOpenedDocumentDraftEntry(tab.path) !== null
          },
          sidebarCollapsed,
          onToggleSidebar: toggleSidebarCollapsed,
        }}
        importInputRef={importInputRef}
        itemMenuOpen={itemMenuOpen}
        activeItemFormat={activeDocumentFormat}
        editorView={editorView}
        editorTextStyleOptions={editorTextStyleOptions}
        hasActiveItem={Boolean(activeDocument)}
        hasUnsavedChanges={hasUnsavedChanges}
        itemWordCount={activeItemWordCount}
        activeItemUpdatedAt={activeDocument?.updated_at}
        canImportSource={canImportSource}
        onFileChange={(file) => void importMarkdownFile(file)}
        onToggleItemMenu={() => setItemMenuOpen((value) => !value)}
        onCloseItemMenu={() => setItemMenuOpen(false)}
        onSetEditorMode={setEditorMode}
        onSetTextStyle={(style) =>
          setEditorView((current) => ({ ...current, textStyle: style }))
        }
        onToggleEditorPreference={toggleEditorPreference}
        onRestoreSavedDraft={restoreSavedDraft}
        onTriggerImport={() => importInputRef.current?.click()}
        onOpenExportDialog={() => {
          setItemMenuOpen(false)
          openExportDialog()
        }}
        onOpenWorkspaceFolder={() => {
          setItemMenuOpen(false)
          if (activeDocument) {
            void openWorkspaceFolder(activeDocument.path)
          }
        }}
        onRunActiveDataTableAction={runActiveDataTableAction}
        formatTime={formatWorkspaceTime}
      />
      <WorkspaceAgentTabBar
        portal={topbarActionsPortal}
        open={workspaceAgentOpen}
        activeSessionId={activeWorkspaceAgentSession?.id || null}
        sessions={agentSessions}
        openSessions={openWorkspaceAgentSessions}
        historyOpen={workspaceAgentHistoryOpen}
        onToggleOpen={toggleActiveAgentPanel}
        onCreateSession={() => void handleCreateWorkspaceAgentChat()}
        onCloseSession={(session) =>
          handleCloseWorkspaceAgentChats([session.id])
        }
        onCloseOtherSessions={(session) =>
          handleCloseWorkspaceAgentChats(
            openWorkspaceAgentSessions
              .filter((other) => other.id !== session.id)
              .map((other) => other.id),
          )
        }
        onCloseAllSessions={() =>
          handleCloseWorkspaceAgentChats(openWorkspaceAgentSessions.map((session) => session.id))
        }
        onCloseLeftSessions={(session) => {
          const index = openWorkspaceAgentSessions.findIndex((item) => item.id === session.id)
          if (index <= 0) {
            return
          }
          handleCloseWorkspaceAgentChats(
            openWorkspaceAgentSessions.slice(0, index).map((other) => other.id),
          )
        }}
        onCloseRightSessions={(session) => {
          const index = openWorkspaceAgentSessions.findIndex((item) => item.id === session.id)
          if (index < 0) {
            return
          }
          handleCloseWorkspaceAgentChats(
            openWorkspaceAgentSessions.slice(index + 1).map((other) => other.id),
          )
        }}
        onCopySessionRef={(session) => {
          const text = session.title || `Chat #${session.id}`
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(text)
          }
        }}
        onSelectSession={(session) =>
          handleWorkspaceAgentSessionSelect(session.id)
        }
        onToggleHistory={() =>
          setWorkspaceAgentHistoryOpen((current) => !current)
        }
      />
      <AgentFloatingLauncher
        visible={!workspaceAgentOpen}
        onOpen={toggleActiveAgentPanel}
      />
      {exportDialogOpen ? (
        <Suspense fallback={null}>
          <DocumentExportDialog
            open
            exporting={exporting}
            exportFormat={exportFormat}
            exportIncludeMedia={exportIncludeMedia}
            exportPageFormat={exportPageFormat}
            exportScale={exportScale}
            pdfIncludeName={pdfIncludeName}
            pdfLandscape={pdfLandscape}
            pdfMarginsType={pdfMarginsType}
            onClose={() => setExportDialogOpen(false)}
            onExportFormatChange={setExportFormat}
            onIncludeMediaChange={setExportIncludeMedia}
            onPageFormatChange={setExportPageFormat}
            onScaleChange={setExportScale}
            onPdfIncludeNameChange={setPdfIncludeName}
            onPdfLandscapeChange={setPdfLandscape}
            onPdfMarginsTypeChange={setPdfMarginsType}
            onExport={() => void exportCurrentDocument()}
          />
        </Suspense>
      ) : null}
      {workspaceFolderDialogOpen ? (
        <Suspense fallback={null}>
          <WorkspaceFolderCreateDialog
            open
            value={workspaceFolderName}
            busy={saving}
            onOpenChange={createFlows.setFolderDialogVisible}
            onValueChange={setWorkspaceFolderName}
            onSubmit={() => void createFlows.submitFolderDialog()}
          />
        </Suspense>
      ) : null}
      {documentTemplateDialogState ? (
        <Suspense fallback={null}>
          <DocumentTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) closeDocumentTemplateDialog()
            }}
            onCreate={handleCreateDocumentFromTemplate}
          />
        </Suspense>
      ) : null}
      {boardCreation.dialogState ? (
        <Suspense fallback={null}>
          <WhiteboardTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) boardCreation.closeTemplateDialog()
            }}
            onSelect={boardCreation.createBoard}
          />
        </Suspense>
      ) : null}
      {kitableTemplateDialogState ? (
        <Suspense fallback={null}>
          <KitableTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) closeKitableTemplateDialog()
            }}
            onSelect={handleCreateKitableFromTemplate}
          />
        </Suspense>
      ) : null}
      {formSyncCreateState ? (
        <Suspense fallback={null}>
          <FormSyncCreateDialog
            open
            documentId={formSyncCreateState.documentId}
            initialTableId={formSyncCreateState.initialTableId}
            onOpenChange={(open) => {
              if (!open) createFlows.closeFormSyncCreate()
            }}
            onCreated={handleFormSyncCreated}
          />
        </Suspense>
      ) : null}
      {autoCreateModeState ? (
        <Suspense fallback={null}>
          <WorkspaceWorkflowCreateModeDialog
            open
            context={autoCreateModeState.context}
            tableOptions={autoCreateModeState.tableOptions}
            onOpenChange={(open) => {
              if (!open) closeWorkflowCreateModeDialog()
            }}
            onSelect={handleWorkflowCreateModeSelect}
            busyKind={autoCreateModeBusyKind}
            busyTemplateId={autoCreateModeBusyTemplateId}
            errorMessage={autoCreateModeError}
            emailSyncTablePath={autoCreateModeState.kitablePath || undefined}
            onSelectEmailSync={(tablePath, runAfterSave) => {
              closeWorkflowCreateModeDialog()
              requestEmailSyncSetup(tablePath, { runAfterSave })
            }}
          />
        </Suspense>
      ) : null}
      <input
        ref={tableFileImportInputRef}
        type="file"
        accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={createFlows.handleTableFileInputChange}
      />
      {tableFileImportState ? (
        <Suspense fallback={null}>
          <TableFileImportDialog
            open
            file={tableFileImportState.file}
            target={{ kind: 'new_document', folder: tableFileImportState.folder }}
            onOpenChange={(open) => {
              if (!open) createFlows.closeTableFileImport()
            }}
            onCompleted={async (result) => {
              const path = result.path
              await refreshWorkspaceDocuments(path, { silent: true, treeOnly: true })
              await kitableChildrenIndex.refresh()
              if (path) {
                openKitableContainer(path)
              }
              notify.success(t('feedback.spreadsheetImported'))
            }}
          />
        </Suspense>
      ) : null}
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
            sidebarPanelProps={{
              activePath: activeResourcePath || activeDocument?.path || '',
              createMenuOpen,
              createMenuTriggerPath,
              loading,
              modifiedPaths: agentModifiedDocumentPaths,
              onOpenCreateMenu: () => {
                setSidebarSectionsExpanded((current) => ({
                  ...current,
                  private: true,
                }))

                openCreateFormatMenu('')
              },
              onCloseCreateMenu: () => {
                workspaceTree.setCreateMenuOpen(false)
                setKitableCreateContext(null)
              },
              onCreateDocument: () => {
                workspaceTree.setCreateMenuOpen(false)
                openDocumentTemplateDialog(createMenuFolder)
              },
              onCreateFolder: () => {
                workspaceTree.setCreateMenuOpen(false)
                createFlows.openFolderDialog()
              },
              onCreateInside: (node) => {
                if (node.type === 'file' && node.name.toLowerCase().endsWith('.kitable') && !node.virtual) {
                  setKitableCreateContext(node.path)
                  setSidebarSectionsExpanded((cur) => ({ ...cur, private: true }))
                  openCreateFormatMenu(undefined, node.path)
                  return
                }
                void createDocumentInside(node)
              },
              onCreateTable: () => {
                if (kitableCreateContext) {
                  void createFlows.createTableFromCreateMenu()
                  return
                }
                workspaceTree.setCreateMenuOpen(false)
                openKitableTemplateDialog(createMenuFolder)
              },
              onImportTableFile: createMenuVariant === 'workspace'
                ? () => {
                    workspaceTree.setCreateMenuOpen(false)
                    createFlows.requestTableFileImport(createMenuFolder)
                  }
                : undefined,
              createMenuVariant,
              onDelete: handleTreeNodeDelete,
              onDuplicate: (node) => void duplicateDocumentNode(node),
              onMoveToFolder: (node, targetNode) => void moveWorkspaceNodeToFolder(node, targetNode),
              onAddToChat: (node) => void addNodeToWorkspaceAgentChat(node),
              onAddToNewChat: (node) => void addNodeToNewWorkspaceAgentChat(node),
              onCreateWorkflowForTable: openWorkflowCreateModeDialog,
              onRevealInOS: isDesktopRuntime()
                ? (node) => void revealWorkspaceFolder(node.path)
                : undefined,
              onOpenWorkflows: () => {
                // Sidebar header lightning-bolt icon. Opens the unscoped
                // global Workflows tab. Same outcome as dispatching the
                // sentinel WORKSPACE_WORKFLOWS_ROOT_PATH through onOpen
                // below — inlined here to avoid the self-reference inside
                // the object literal.
                onCloseProfile?.()
                openWorkspaceWorkflow()
              },
              onCreateDesign: () => { onCloseProfile?.(); void design.create(createMenuFolder) },
              onCreateBoard: () => {
                onCloseProfile?.()
                boardCreation.openTemplateDialog(createMenuFolder)
              },
              onOpen: (path) => {
                onCloseProfile?.()
                // Mirror the tab strip's onActivate: when the full-screen
                // /workflow route is up it masks the editor pane, so a
                // sidebar click into a non-workflow node only flips the
                // active tab — the user sees no change. Close the route
                // for anything that isn't itself a workflow tree node.
                const opensWorkflowTab = path.startsWith('workflows://') || path.startsWith('workflow://')
                if (workflowOpen && !opensWorkflowTab) {
                  onCloseWorkflow?.()
                }
                if (path.toLowerCase().endsWith('.kidesign')) {
                  design.open(path)
                  return
                }
                if (path.toLowerCase().endsWith('.kiboard')) {
                  openBoard(path)
                  return
                }
                if (path.toLowerCase().endsWith('.kitable')) {
                  openKitableContainer(path)
                  return
                }
                if (routeKitableOpenPath(path, kitableChildrenIndex, upsertWorkspaceTab)) {
                  // Sidebar highlight keys off activeResourcePath. The
                  // tab opener doesn't know the virtual path it came from
                  // (it sees kitablePath + tableId), so push the virtual
                  // path here too — otherwise the previous document
                  // remains visually selected in the file tree.
                  const tableResource = parseKitableTableVirtualPath(path)
                  const dashboardResource = parseKitableDashboardVirtualPath(path)
                  setActiveResourcePath(
                    tableResource?.kitablePath || dashboardResource?.kitablePath || path,
                  )
                  return
                }
                // Virtual "Workflows" leaf under each .kitable file is
                // synthesized by workspaceTree — it carries a sentinel
                // path that routes through the DocTab system instead of
                // touching the filesystem.
                if (path.startsWith('workflows://')) {
                  const kitablePath = path.slice('workflows://'.length)
                  const tabId = kitablePath ? buildKitableWorkspaceTabId(kitablePath) : 'workflow:home'
                  const title = kitablePath ? getKitableWorkspaceTabTitle(kitablePath) : t('tabs.workflowsTitle')
                  upsertWorkspaceTab({ id: tabId, type: 'workflow', title, kitablePath: kitablePath || undefined })
                  return
                }
                // Virtual per-workflow leaf under a .kitable. The path
                // encodes both the kitable scope and the workflow id so
                // the tab opens scoped + pre-selected.
                if (path.startsWith('workflow://')) {
                  const parsed = parseKitableWorkflowVirtualPath(path)
                  if (parsed) {
                    upsertWorkspaceTab({
                      id: buildKitableWorkspaceTabId(parsed.kitablePath),
                      type: 'workflow',
                      title: getKitableWorkspaceTabTitle(parsed.kitablePath),
                      kitablePath: parsed.kitablePath,
                      workflowId: parsed.workflowId,
                    })
                  }
                  return
                }
                void openDocument(path)
              },
              showBrowserTab: WEB_BROWSER_ENABLED && isDesktopRuntime(),
              onRefresh: () => {
                void refreshWorkspaceDocuments(undefined, { silent: true, treeOnly: true })
                  .then((ok) => {
                    if (ok) notify.success(t('feedback.refreshed'))
                  })
              },
              onRename: handleTreeNodeRename,
              onSetIcon: setWorkspaceItemIcon,
              onToggleFolder: toggleFolder,
              onTogglePrivate: () => toggleSidebarSection('private'),
              onToggleSidebar: toggleSidebarCollapsed,
              onTreeDrop: (draggedPath, targetPath, position) =>
                void dropWorkspaceNode(draggedPath, targetPath, position),
              onImportFiles: isDesktopRuntime()
                ? (files, folder) => void importBrowserFiles(files, folder)
                : undefined,
              onPasteFiles: isDesktopRuntime()
                ? (entries) => void importBrowserFiles(entries)
                : undefined,
              privateExpanded: sidebarSectionsExpanded.private,
              rootPath,
              treeExpandedPaths: expandedPaths,
              treeIcons: treeMetadata.icons,
              moveTargets: workspaceMoveTargets,
              workspaceDisplayName,
              workspaceTreeNodes,
              onOpenSearch,
            }}
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
          <div className={cn('workspace-editor-frame', activeKitablePath && 'has-kitable-sidebar')}>
            {activeKitablePath ? (
              <WorkspaceKitableSidebar
                key={activeKitablePath}
                mode={activeKitableMode}
                activeDashboardId={activeWorkspaceTab?.type === 'dashboard' ? activeWorkspaceTab.dashboardId : undefined}
                activeTableId={activeWorkspaceTab?.type === 'table' ? activeWorkspaceTab.tableId : undefined}
                activeWorkflowId={activeWorkspaceTab?.type === 'workflow' ? activeWorkspaceTab.workflowId : undefined}
                dashboards={kitableChildrenIndex.dashboardsByKitablePath[activeKitablePath] || []}
                tables={kitableChildrenIndex.tablesByKitablePath[activeKitablePath] || []}
                workflows={kitableChildrenIndex.workflowsByKitablePath[activeKitablePath] || []}
                onCreateDashboard={() => void createDashboardFromKitableSidebar(activeKitablePath)}
                onCreateTable={() => void createTableFromKitableSidebar(activeKitablePath)}
                onCreateForm={() => createFormFromKitableSidebar(activeKitablePath)}
                onCreateWorkflow={() => createWorkflowFromKitableSidebar(activeKitablePath)}
                onOpenDashboard={(dashboardId) => openKitableDashboard(activeKitablePath, dashboardId)}
                onOpenTable={(tableId) => openKitableTable(activeKitablePath, tableId)}
                onOpenWorkflow={(workflowId) => openKitableWorkflow(activeKitablePath, workflowId)}
                onRenameTable={(tableId, currentTitle, nextTitle) => void renameKitableTableLeaf({
                  type: 'file',
                  virtual: true,
                  path: buildKitableTableVirtualPath(activeKitablePath, tableId),
                  name: currentTitle,
                  title: currentTitle,
                  format: 'data',
                  parentPath: activeKitablePath,
                  children: [],
                }, nextTitle)}
              />
            ) : null}
            <div className="workspace-editor-frame__content">
              {workflowWorkbench || (
                <WorkspaceScreenEditor
                  editorContentProps={{
                    designRoot: rootPath,
                    activeDocument,
                    activeDocumentFormat,
                    activeDocumentRevision,
                    activeWorkspaceTab,
                    activeWorkspaceTabId,
                    documentTitle: activeDocument ? getWorkspaceItemTitle(activeDocument.name) : '',
                    draftContent,
                    hasActiveDocument: Boolean(activeDocument),
                    editorLocked: editorView.locked,
                    editorMode: editorView.editorMode,
                    editorPreviewHtml,
                    editorResetVersions,
                    documentRevisionSaving,
                    documentEditorFocusRequest,
                    galleryPanelProps,
                    browserOriginDocumentPath,
                    browserPanelPhase,
                    browserToolbarStatus,
                    onBrowserNavigate: (address) => void handleBrowserNavigate(address),
                    onBrowserBack: handleBrowserBack,
                    onBrowserForward: handleBrowserForward,
                    onBrowserReload: handleBrowserReload,
                    onBrowserStop: handleBrowserStop,
                    getOpenedDocumentDraftEntry,
                    whiteboardAgentAvailable,
                    whiteboardAgentBusy: activeWorkspaceAgentSession
                      ? agentBusySessions.has(activeWorkspaceAgentSession.id)
                      : false,
                    onWhiteboardAgentBridgeChange: handleWhiteboardAgentBridgeChange,
                    onCancelWhiteboardAgent: activeWorkspaceAgentSession
                      ? () => stopAgentMessage(activeWorkspaceAgentSession.id)
                      : undefined,
                    onGenerateWhiteboardImage: handleGenerateWhiteboardImage,
                    onTableAgentContextChange: handleTableAgentContextChange,
                    onCreateWorkflow: createWorkflowFromKitableSidebar,
                    onOpenWorkflow: openKitableWorkflow,
                    onOpenGlobalWorkflow: openWorkspaceWorkflow,
                    onOpenWorkflows: () => openWorkspaceWorkflow(),
                    onCreateDocument: () => {
                      openDocumentTemplateDialog('')
                    },
                    onCreateTable: () => {
                      openKitableTemplateDialog('')
                    },
                    onOpenAgent: () => {
                      setWorkspaceAgentOpen(true)
                      setWorkspaceAgentHistoryOpen(false)
                      window.dispatchEvent(new CustomEvent('kition:agent:focus-composer'))
                    },
                    onAskDocumentAgent: (request) => void handleDocumentAskAgent(request),
                    onAgentInsertionContextChange: handleAgentInsertionContextChange,
                    onSaveDocumentTitle: (nextTitle: string) => void saveDocumentTitle(nextTitle),
                    onDecideDocumentRevisionChange: (changeId, decision) => {
                      if (activeDocumentRevision) {
                        decideDocumentRevisionChange(activeDocumentRevision.path, changeId, decision)
                      }
                    },
                    onResolveAllDocumentRevisionChanges: (decision) => {
                      if (activeDocumentRevision) {
                        resolveAllDocumentRevisionChanges(activeDocumentRevision.path, decision)
                      }
                    },
                    onSplitEditorChange: (value) => {
                      handleDraftContentChange(value)
                      setFeedback('')
                    },
                    onOpenDocument: (path) => void openDocument(path),
                    onToolbarMount: handleDocumentToolbarMount,
                    onSetEditorMode: setEditorMode,
                    tableAgentOpen: workspaceAgentOpen,
                    onTableAgentOpenChange: (open) => {
                      setWorkspaceAgentOpen(open)
                      setWorkspaceAgentHistoryOpen(false)
                    },
                    workspaceTabs,
                    rootPath,
                  }}
                />
              )}
            </div>
          </div>
        )}
      />
    </>
  )
}
