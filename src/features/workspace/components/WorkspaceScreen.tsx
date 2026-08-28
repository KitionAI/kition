import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useKitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import {
  buildKitableWorkflowVirtualPath,
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
import type { AgentBrowserContext, AgentEvent } from '@/api/agent'
import {
  appendAgentLocalSource,
  extractAgentLocalPathReference,
} from '@/features/agent/lib/agentLocalSources'
import { createDataDashboardByPath } from '@/api/dashboards'
import { openDataDocumentByPath, renameDataDocumentByPath } from '@/api/dataDocuments'
import { openWorkflowHome, openWorkflowRoute, type WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import { createWorkflow, type WorkflowDefinition } from '@/features/workflow/api'
import { createWorkflowFromMode } from '@/features/workflow/lib/createWorkflowFromMode'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { useWorkspaceAgent } from '@/features/agent/hooks/useWorkspaceAgent'
import { useKitionAccount } from '@/features/account/hooks/useKitionAccount'
import { getKitionAccountLinks } from '@/features/account/lib/accountLinks'
import { isKitionAccountSessionUsable } from '@/features/account/lib/accountState'
import {
  type AgentBrowserOpenRequest,
  extractAgentBrowserContinuationContext,
  findLatestBrowserContinuationRequest,
  readBrowserOpenRequest,
} from '@/features/agent/lib/agentBrowserContinuation'
import {
  buildAgentBrowserTabPayload,
  dispatchOpenWorkspaceBrowserTab,
} from '@/features/agent/lib/agentBrowserTab'
import {
  buildBrowserAutoContinuePrompt,
  buildBrowserUnavailablePrompt,
  extractAgentWebTarget,
  MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS,
} from '@/features/agent/lib/agentBrowserIntent'
import { preflightAgentBrowserContext } from '@/features/agent/lib/agentBrowserPreflight'
import {
  type AgentTurnContext,
  buildActiveBrowserTabContext,
  buildAgentTurnContext,
  finalizeAgentTurnContext,
  mapBrowserPageContextToAgentBrowserContext,
} from '@/features/agent/lib/agentTurnContext'
import type { MarkdownImageInsertionSnapshot } from '@/features/document/editor/editor/markdown-image-insertion'
import { useDocumentExport } from '@/features/document/hooks/useDocumentExport'
import { useWorkspaceDocumentSession } from '@/features/document/hooks/useWorkspaceDocumentSession'
import type { DocumentCreationPreset } from '@/features/document/lib/documentCreation'
import type { DocumentAskAgentRequest } from '@/features/document/lib/documentAgentActions'
import { createBoardWorkspaceFile } from '@/features/whiteboard/lib/boardFile'
import type { WhiteboardAgentBridge } from '@/features/whiteboard/lib/whiteboardAgentBridge'
import { runtimeSupportsWhiteboard } from '@/features/whiteboard/lib/whiteboardCapabilities'
import { AgentFloatingLauncher } from '@/features/agent/components/AgentFloatingLauncher'
import type { SettingsSectionKey } from '@/features/settings/DesktopSettingsPage'
import { useDesktopSettings } from '@/features/settings/hooks/useDesktopSettings'
import type { DataDocument, DataTable } from '@/types/dataDocument'
import type { KitableTemplateDefinition } from '@/features/table/templates/kitableTemplates'
import { WorkspaceScreenEditor } from '@/features/workspace/components/WorkspaceScreenEditor'
import { WorkspaceKitableSidebar } from '@/features/workspace/components/WorkspaceKitableSidebar'
import type { WorkspaceWorkflowCreateModeChoice } from '@/features/workspace/components/WorkspaceWorkflowCreateModeDialog'
import { requestEmailSyncSetup } from '@/features/emailSync/setupRequest'
import { FORM_SYNC_CHANGED_EVENT, type FormSyncWorkflow } from '@/features/formSync/api'
import { setupTemplateFormSync } from '@/features/formSync/templateSetup'
import { useKitableTableLeafActions } from '@/features/workspace/hooks/useKitableTableLeafActions'
import { useKitableDashboardLeafActions } from '@/features/workspace/hooks/useKitableDashboardLeafActions'
import { useKitableWorkflowLeafActions } from '@/features/workspace/hooks/useKitableWorkflowLeafActions'
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
import { setPinnedTabsWorkspace } from '@/features/document/editor/hooks/usePinnedTabs'
import {
  applyWorkspaceBrowserSessionSnapshot,
  buildWorkspaceBrowserTabId,
  buildWorkspaceBrowserTabTitle,
  findWorkspaceBrowserTabIdsForSnapshot,
  OPEN_WORKSPACE_BROWSER_TAB_EVENT,
  resolveWorkspaceBrowserTabOrigin,
  resolveWorkspaceBrowserHost,
  resolveWorkspaceBrowserTabNavigationURL,
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
  type WorkspaceTab,
  type WorkspaceTreeNode,
} from '@/features/workspace/lib/workspace'
import {
  deriveAgentPaneContext,
  resolveAgentActiveDocument,
  resolveAgentDataTableTarget,
} from '@/features/workspace/lib/agentPaneContext'
import {
  readWorkspaceAgentActiveSessionId,
  writeWorkspaceAgentActiveSessionId,
} from '@/features/workspace/lib/workspacePersistence'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import {
  ensureBrowserSessionWindow,
  chooseAgentAnalysisDirectory,
  extractBrowserPageContext,
  getBrowserSessionPanelState,
  getBrowserSessionStatus,
  getDesktopBackendStatus,
  hideBrowserSessionPanel,
  isDesktopRuntime,
  moveWorkspaceDocument,
  openExternalURL,
  registerBrowserSessionStateHandler,
  revealWorkspaceFolder,
  browserSessionGoBack,
  browserSessionGoForward,
  browserSessionReload,
  browserSessionStop,
  setBrowserSessionHostLayout,
  type BrowserSessionPanelState,
  type BrowserSessionProvider,
  type BrowserSessionRequest,
  type BrowserSessionStatus,
  type WorkspaceDocument,
  type WorkspaceDocumentFormat,
} from '@/services/desktop'
import { WORKSPACE_BROWSER_TOOLBAR_HEIGHT } from '@/features/workspace/components/WorkspaceBrowserToolbar'
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

type WorkspaceTableAgentContext = {
  activeDocument: DataDocument | null
  activeTable: DataTable | null
  onTableChanged?: () => Promise<void> | void
}

type WorkspaceTableAgentTarget = {
  documentPath: string
  tableId: number | null
  originLabel: string
}

const WORKSPACE_BROWSER_TAB_CHROME_TOP_INSET = 98
const WORKSPACE_BROWSER_TAB_TOP_INSET =
  WORKSPACE_BROWSER_TAB_CHROME_TOP_INSET + WORKSPACE_BROWSER_TOOLBAR_HEIGHT

// The native browser view must overlay the `.workspace-browser-tab` placeholder
// exactly. Measure its on-screen top so the view never starts below the
// placeholder, which would expose the placeholder's gradient as an empty strip.
function measureBrowserTabTopInset() {
  if (typeof document === 'undefined') {
    return WORKSPACE_BROWSER_TAB_TOP_INSET
  }
  const node = document.querySelector('.workspace-browser-tab')
  if (!node) {
    return WORKSPACE_BROWSER_TAB_TOP_INSET
  }
  const top = Math.round(node.getBoundingClientRect().top)
  return Number.isFinite(top) && top > 0 ? top : WORKSPACE_BROWSER_TAB_TOP_INSET
}

const WORKSPACE_BROWSER_TAB_REATTACH_LIMIT = 3

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
  }, [rootPath])
  // .kitable files imported through onboarding guides,
  // drag-drop) are only written to disk — nothing registers a DataDocument row,
  // so listDataDocuments returns nothing for them and the tree renders the
  // container with no table leaves to click. Lazily index any .kitable that the
  // tree knows about but the backend hasn't seen yet, then refresh the children
  // index so the table leaves appear. Idempotent on the backend; the attempted
  // set stops re-tries for genuinely unopenable files.
  const kitableRegisterAttemptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (kitableChildrenIndex.status !== 'done') return
    const unregistered = files
      .filter((file) => file.type === 'file' && file.path.toLowerCase().endsWith('.kitable'))
      .map((file) => file.path)
      .filter(
        (path) =>
          !(path in kitableChildrenIndex.docIdByKitablePath) &&
          !kitableRegisterAttemptedRef.current.has(path),
      )
    if (unregistered.length === 0) return
    unregistered.forEach((path) => kitableRegisterAttemptedRef.current.add(path))
    void (async () => {
      let registeredAny = false
      for (const path of unregistered) {
        try {
          await openDataDocumentByPath({ path })
          registeredAny = true
        } catch {
          // Corrupt / unreadable .kitable: leave it leafless rather than looping.
        }
      }
      if (registeredAny) {
        void kitableChildrenIndex.refresh()
      }
    })()
  }, [files, kitableChildrenIndex.status, kitableChildrenIndex.docIdByKitablePath, kitableChildrenIndex.refresh])
  const [error, setError] = useState('')
  const [, setFeedback] = useState('')
  const [workspaceAgentOpen, setWorkspaceAgentOpen] = useState(false)
  const [workspaceAgentHistoryOpen, setWorkspaceAgentHistoryOpen] = useState(false)
  const [activeWorkspaceAgentSessionId, setActiveWorkspaceAgentSessionId] =
    useState<number | null>(null)
  const [closedWorkspaceAgentSessionIds, setClosedWorkspaceAgentSessionIds] =
    useState<Set<number>>(() => new Set())
  const [tableAgentContextByPath, setTableAgentContextByPath] = useState<
    Record<string, WorkspaceTableAgentContext>
  >({})
  const [lastTableAgentTarget, setLastTableAgentTarget] =
    useState<WorkspaceTableAgentTarget>({
      documentPath: '',
      tableId: null,
      originLabel: '',
    })
  const [browserPanelPhase, setBrowserPanelPhase] = useState<
    'loading' | 'ready' | 'unavailable' | 'empty'
  >('loading')
  const [browserNavState, setBrowserNavState] =
    useState<BrowserSessionPanelState | null>(null)
  const [workspaceFolderDialogOpen, setWorkspaceFolderDialogOpen] = useState(false)
  const [workspaceFolderName, setWorkspaceFolderName] = useState('')
  const [documentTemplateDialogState, setDocumentTemplateDialogState] = useState<{
    folderOverride?: string
  } | null>(null)
  const [documentEditorFocusRequest, setDocumentEditorFocusRequest] = useState(0)
  const [kitableTemplateDialogState, setKitableTemplateDialogState] = useState<{
    folderOverride?: string
  } | null>(null)
  const [tableFileImportState, setTableFileImportState] = useState<{
    file: File
    folder?: string
  } | null>(null)
  const tableFileImportFolderRef = useRef('')
  const tableFileImportInputRef = useRef<HTMLInputElement | null>(null)
  const [kitableCreateContext, setKitableCreateContext] = useState<string | null>(null)
  const [formSyncCreateState, setFormSyncCreateState] = useState<{
    kitablePath: string
    documentId: string
    initialTableId?: number
  } | null>(null)
  const createMenuVariant: 'workspace' | 'kitable' = kitableCreateContext ? 'kitable' : 'workspace'
  // Group A: when the user picks "Create Workflow" from a kitable table
  // leaf's "..." menu, we surface a mode chooser (template vs AI). The dialog
  // can run scoped to a (documentId, tableId) pair OR entirely unbound
  // (delayed table binding). When context is non-null the user picked a leaf
  // table or a kitable with exactly one table; null signals "create a draft
  // — the user will pick the table inside the trigger config panel
  // afterwards". kitablePath, when set, controls where the resulting
  // workflow lands in the workspace tree.
  const [autoCreateModeState, setAutoCreateModeState] = useState<
    {
      context: WorkflowRouteContext | null
      tableOptions: WorkflowRouteContext[]
      kitablePath: string | null
    } | null
  >(null)
  const [autoCreateModeBusyKind, setAutoCreateModeBusyKind] = useState<'template' | 'chat' | 'scratch' | null>(null)
  const [autoCreateModeBusyTemplateId, setAutoCreateModeBusyTemplateId] = useState<string | undefined>(undefined)
  const [autoCreateModeError, setAutoCreateModeError] = useState<string | null>(null)
  const [agentBrowserEnabled, setAgentBrowserEnabledState] = useState(false)
  const [whiteboardAgentAvailable, setWhiteboardAgentAvailable] = useState(false)
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
  const lastSyncedBrowserTabIdRef = useRef('')
  const browserTabReattachCountRef = useRef<Record<string, number>>({})
  const agentDocumentStateRef = useRef({
    clearModifiedPath: (_path: string) => {},
    modifiedPaths: new Set<string>(),
  })
  const agentTurnContextRef = useRef<AgentTurnContext>({
    activeDocumentPath: '',
    activeDataDocumentId: 0,
    activeDataTableId: 0,
    taskMode: 'auto',
    browserEnabled: false,
  })
  const markdownImageInsertionSnapshotRef = useRef<MarkdownImageInsertionSnapshot | null>(null)
  const handleAgentInsertionContextChange = useCallback((
    documentPath: string,
    context: MarkdownImageInsertionSnapshot | null,
  ) => {
    if (context) {
      markdownImageInsertionSnapshotRef.current = context
    } else if (markdownImageInsertionSnapshotRef.current?.documentPath === documentPath) {
      markdownImageInsertionSnapshotRef.current = null
    }
  }, [])
  const activeWhiteboardPathRef = useRef('')
  const whiteboardAgentBridgesRef = useRef<Record<string, WhiteboardAgentBridge>>({})
  const prepareAgentBrowserContextRef = useRef<
    (content: string) => Promise<AgentBrowserContext | undefined>
  >(async () => undefined)
  const prepareAgentBrowserContextForTurn = useCallback(
    (content: string) => prepareAgentBrowserContextRef.current(content),
    [],
  )
  const setAgentBrowserEnabled = useCallback((next: boolean) => {
    setAgentBrowserEnabledState(next)
    agentTurnContextRef.current = {
      ...agentTurnContextRef.current,
      browserEnabled: next,
    }
  }, [])

  const tableAgentRefreshRef = useRef<(() => Promise<void> | void) | null>(null)
  const activeBrowserTabRef = useRef<Extract<
    WorkspaceTab,
    { type: 'browser' }
  > | null>(null)
  const getAgentTurnContext = useCallback(
    async (): Promise<AgentTurnContext> => {
      const base = finalizeAgentTurnContext({
        baseContext: agentTurnContextRef.current,
        markdownImageInsertionSnapshot: markdownImageInsertionSnapshotRef.current,
      })
      const whiteboardPath = activeWhiteboardPathRef.current
      const whiteboardContext = base.paneContext === 'whiteboard'
        ? whiteboardAgentBridgesRef.current[whiteboardPath]?.buildContext()
        : undefined
      const scopedBase = { ...base, whiteboardContext }
      const tab = activeBrowserTabRef.current
      if (!tab) {
        return scopedBase
      }
      try {
        const pageContext = await extractBrowserPageContext({
          provider: tab.provider,
        })
        const enriched = mapBrowserPageContextToAgentBrowserContext(
          pageContext,
          tab.provider,
        )
        if (enriched) {
          return { ...scopedBase, browserContext: enriched }
        }
      } catch {
        // The embedded browser may be unavailable (e.g. dev browser build);
        // fall back to the thin tab metadata already in the base context.
      }
      return scopedBase
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    void getDesktopBackendStatus()
      .then((status) => {
        if (!cancelled) {
          setWhiteboardAgentAvailable(runtimeSupportsWhiteboard(status?.capabilities))
        }
      })
      .catch(() => {
        if (!cancelled) setWhiteboardAgentAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const handleWhiteboardAgentBridgeChange = useCallback((
    path: string,
    bridge: WhiteboardAgentBridge | null,
  ) => {
    if (bridge) {
      whiteboardAgentBridgesRef.current[path] = bridge
    } else {
      delete whiteboardAgentBridgesRef.current[path]
    }
  }, [])

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
    onWhiteboardPatch: ({ boardPath, patch, provisional }) => {
      if (!whiteboardAgentAvailable) return
      whiteboardAgentBridgesRef.current[boardPath]?.receivePatch(patch, provisional)
    },
    onWhiteboardPatchCancelled: ({ boardPath }) => {
      whiteboardAgentBridgesRef.current[boardPath]?.cancelPreview()
    },
    prepareActiveDocument: ensureActiveDocumentSaved,
    getTurnContext: getAgentTurnContext,
    prepareBrowserContext: prepareAgentBrowserContextForTurn,
  })
  agentDocumentStateRef.current = {
    clearModifiedPath: clearModifiedDocumentPath,
    modifiedPaths: agentModifiedDocumentPaths,
  }
  const openWorkspaceAgentSessions = useMemo(
    () => agentSessions.filter((session) => !closedWorkspaceAgentSessionIds.has(session.id)),
    [agentSessions, closedWorkspaceAgentSessionIds],
  )

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
    closeWorkspaceTab(tabId)
    if (workflowOpen && closing.type === 'workflow') {
      const remainingWorkflow = tabs.some((t) => t.id !== tabId && t.type === 'workflow')
      if (!remainingWorkflow) onCloseWorkflow?.()
    }
  }, [closeWorkspaceTab, onCloseWorkflow, workflowOpen])

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
  activeBrowserTabRef.current = activeBrowserTab

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
    if (activeWorkspaceTab.type === 'board') {
      setActiveResourcePath(activeWorkspaceTab.path)
      return
    }
    if (activeWorkspaceTab.type === 'workflow' && activeWorkspaceTab.kitablePath) {
      setActiveResourcePath(activeWorkspaceTab.kitablePath)
    }
  }, [activeWorkspaceTab, setActiveResourcePath])

  const openKitableTable = useCallback((kitablePath: string, tableId: number) => {
    if (workflowOpen) {
      onCloseWorkflow()
    }
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'table',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      tableId,
      format: 'data',
    })
    setActiveResourcePath(kitablePath)
  }, [onCloseWorkflow, setActiveResourcePath, upsertWorkspaceTab, workflowOpen])

  const openKitableDashboard = useCallback((kitablePath: string, dashboardId: string) => {
    if (workflowOpen) {
      onCloseWorkflow()
    }
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'dashboard',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      dashboardId,
      format: 'data',
    })
    setActiveResourcePath(kitablePath)
  }, [onCloseWorkflow, setActiveResourcePath, upsertWorkspaceTab, workflowOpen])

  const openKitableWorkflow = useCallback((kitablePath: string, workflowId?: string) => {
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'workflow',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      workflowId,
    })
    setActiveResourcePath(kitablePath)
  }, [setActiveResourcePath, upsertWorkspaceTab])

  const openWorkspaceWorkflow = useCallback((workflowId?: string) => {
    if (workflowOpen) {
      onCloseWorkflow()
    }
    upsertWorkspaceTab({
      id: 'workflow:home',
      type: 'workflow',
      title: t('tabs.workflowsTitle'),
      workflowId,
    })
  }, [onCloseWorkflow, t, upsertWorkspaceTab, workflowOpen])

  const openBoard = useCallback((path: string) => {
    const normalizedPath = String(path || '').trim()
    if (!normalizedPath) {
      return
    }
    if (workflowOpen) {
      onCloseWorkflow?.()
    }
    const filename = normalizedPath.split('/').pop() || normalizedPath
    upsertWorkspaceTab({
      id: `board:${normalizedPath}`,
      type: 'board',
      title: getWorkspaceItemTitle(filename),
      path: normalizedPath,
    })
    setActiveResourcePath(normalizedPath)
  }, [
    onCloseWorkflow,
    setActiveResourcePath,
    upsertWorkspaceTab,
    workflowOpen,
  ])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; vaultPath?: string }
      const path = detail?.path || detail?.vaultPath
      if (!path) {
        return
      }
      if (path.toLowerCase().endsWith('.kiboard')) {
        openBoard(path)
        return
      }
      void openDocument(path)
    }
    window.addEventListener('kition:search:open-path', handler)
    return () => window.removeEventListener('kition:search:open-path', handler)
  }, [openBoard, openDocument])

  useEffect(() => {
    function openLocalWorkflow(event: Event) {
      const kitablePath = String(
        (event as CustomEvent<{ kitablePath?: string }>).detail?.kitablePath || '',
      ).trim()
      if (kitablePath) {
        openKitableWorkflow(kitablePath)
      }
    }
    window.addEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
    return () => window.removeEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
  }, [openKitableWorkflow])

  const pendingKitableOpenPathRef = useRef('')
  const refreshedKitableOpenPathRef = useRef('')
  const openKitableContainer = useCallback((kitablePath: string) => {
    const tables = [...(kitableChildrenIndex.tablesByKitablePath[kitablePath] || [])]
      .sort((left, right) => left.order - right.order)
    if (tables.length === 0) {
      const waitingForCurrentRefresh = kitableChildrenIndex.status === 'idle'
        || kitableChildrenIndex.status === 'loading'
      const needsFreshLookup = kitableChildrenIndex.status === 'done'
        && refreshedKitableOpenPathRef.current !== kitablePath
      if (waitingForCurrentRefresh || needsFreshLookup) {
        pendingKitableOpenPathRef.current = kitablePath
        setActiveResourcePath(kitablePath)
        if (needsFreshLookup) {
          refreshedKitableOpenPathRef.current = kitablePath
          void kitableChildrenIndex.refresh()
        }
        return
      }
    }
    pendingKitableOpenPathRef.current = ''
    refreshedKitableOpenPathRef.current = ''
    const currentTableId = activeWorkspaceTab?.type === 'table'
      && activeWorkspaceTab.kitablePath === kitablePath
      ? activeWorkspaceTab.tableId
      : undefined
    const targetTableId = currentTableId ?? tables[0]?.id
    if (targetTableId != null) {
      openKitableTable(kitablePath, targetTableId)
      return
    }
    openKitableWorkflow(kitablePath)
  }, [
    activeWorkspaceTab,
    kitableChildrenIndex.refresh,
    kitableChildrenIndex.status,
    kitableChildrenIndex.tablesByKitablePath,
    openKitableTable,
    openKitableWorkflow,
    setActiveResourcePath,
  ])

  useEffect(() => {
    if (kitableChildrenIndex.status !== 'done') return
    const pendingPath = pendingKitableOpenPathRef.current
    if (!pendingPath) return
    openKitableContainer(pendingPath)
  }, [kitableChildrenIndex.status, openKitableContainer])

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

  const browserOriginDocumentPath = String(
    activeBrowserTab?.originDocumentPath || '',
  ).trim()
  const browserOriginTableId =
    typeof activeBrowserTab?.originTableId === 'number'
      ? activeBrowserTab.originTableId
      : null
  const browserResolvedDocumentPath =
    browserOriginDocumentPath || lastTableAgentTarget.documentPath
  const browserResolvedTableId =
    browserOriginTableId ?? lastTableAgentTarget.tableId
  const activeDataTableTarget = resolveAgentDataTableTarget(activeWorkspaceTab)
  const activeDataWorkspaceTabPath = activeDataTableTarget?.documentPath || ''
  const activeDataWorkspaceTableId = activeDataTableTarget?.tableId ?? null
  const activeDataWorkspaceTabPathRef = useRef('')
  activeDataWorkspaceTabPathRef.current = activeDataWorkspaceTabPath
  const lastTableAgentTargetRef = useRef(lastTableAgentTarget)
  lastTableAgentTargetRef.current = lastTableAgentTarget
  const tableAgentDocumentPath = useMemo(() => {
    if (activeDataWorkspaceTabPath) {
      return activeDataWorkspaceTabPath
    }
    if (activeWorkspaceTab?.type === 'browser') {
      return browserResolvedDocumentPath
    }
    return ''
  }, [activeDataWorkspaceTabPath, activeWorkspaceTab?.type, browserResolvedDocumentPath])
  const tableAgentContext = tableAgentDocumentPath
    ? tableAgentContextByPath[tableAgentDocumentPath] || null
    : null
  tableAgentRefreshRef.current = tableAgentContext?.onTableChanged ?? null
  const hasTableAgentTarget = Boolean(tableAgentDocumentPath)
  const agentActiveDocument = resolveAgentActiveDocument(activeWorkspaceTab)
  activeWhiteboardPathRef.current = activeWorkspaceTab?.type === 'board'
    ? activeWorkspaceTab.path
    : ''
  agentTurnContextRef.current = buildAgentTurnContext({
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
  const activeWorkspaceAgentSession = activeWorkspaceAgentSessionId
    ? agentSessions.find((session) => session.id === activeWorkspaceAgentSessionId) || null
    : null
  const activeWorkspaceDocumentPath = resolveAgentActiveDocument(activeWorkspaceTab).path
  const activeAgentDocumentContextPaths = activeWorkspaceAgentSession
    ? resolveAgentDocumentContexts(
      activeWorkspaceAgentSession.id,
      activeWorkspaceDocumentPath,
    )
    : []

  const refreshTableAgentContextByPath = useCallback(async (
    path: string,
    preferredTableId?: number | null,
  ) => {
    const normalizedPath = String(path || '').trim()
    if (!normalizedPath) {
      return null
    }
    const document = await openDataDocumentByPath({ path: normalizedPath })
    const preferredTable = preferredTableId
      ? document.tables?.find((table) => table.id === preferredTableId) || null
      : null
    const activeTable = preferredTable || document.tables?.[0] || null
    const nextContext: WorkspaceTableAgentContext = {
      activeDocument: document,
      activeTable,
      onTableChanged: async () => {
        await refreshTableAgentContextByPath(normalizedPath, activeTable?.id || preferredTableId || null)
      },
    }
    setTableAgentContextByPath((current) => ({
      ...current,
      [normalizedPath]: nextContext,
    }))
    return nextContext
  }, [])

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

  const handleCreateBoard = useCallback(async () => {
    workspaceTree.setCreateMenuOpen(false)
    setSaving(true)
    setError('')
    setFeedback('')

    try {
      const created = await createBoardWorkspaceFile({ folder: createMenuFolder })
      if (createMenuFolder) {
        workspaceTree.expandFolders([createMenuFolder])
      }
      await refreshWorkspaceDocuments(undefined, { silent: true, treeOnly: true })
      openBoard(created.path)
      notify.success(t('feedback.boardCreated'))
    } catch (requestError: any) {
      setError(requestError?.message || t('errors.createBoardFailed'))
    } finally {
      setSaving(false)
    }
  }, [
    createMenuFolder,
    openBoard,
    refreshWorkspaceDocuments,
    setSaving,
    t,
    workspaceTree,
  ])
  refreshWorkspaceDocumentsRef.current = refreshWorkspaceDocuments

  const handleCreateDocumentFromTemplate = useCallback(async (
    preset?: DocumentCreationPreset,
  ) => {
    if (!documentTemplateDialogState) return false
    const created = await createDocument(
      selectedPlatform,
      documentTemplateDialogState.folderOverride,
      preset,
    )
    if (created) {
      setDocumentTemplateDialogState(null)
      if (!preset) setDocumentEditorFocusRequest((current) => current + 1)
    }
    return created
  }, [createDocument, documentTemplateDialogState, selectedPlatform])

  const handleCreateKitableFromTemplate = useCallback(async (
    template?: KitableTemplateDefinition,
  ) => {
    if (!kitableTemplateDialogState) return false
    const result = await createTable(kitableTemplateDialogState.folderOverride, template)
    if (!result) return false
    if (result.tableId != null) {
      workspaceTree.updateTreeMetadata((current) => {
        if (current.collapsed.includes(result.kitablePath)) return current
        return { ...current, collapsed: [...current.collapsed, result.kitablePath] }
      })
      upsertWorkspaceTab({
        id: buildKitableWorkspaceTabId(result.kitablePath),
        type: 'table',
        title: getKitableWorkspaceTabTitle(result.kitablePath),
        kitablePath: result.kitablePath,
        tableId: result.tableId,
        format: 'data',
      })
      setActiveResourcePath(buildKitableTableVirtualPath(result.kitablePath, result.tableId))
    }
    setKitableTemplateDialogState(null)
    void kitableChildrenIndex.refresh()
    if (template?.afterCreate?.type === 'email-sync') {
      requestEmailSyncSetup(result.kitablePath, {
        runAfterSave: template.afterCreate.runAfterSave,
      })
    }
    if (template?.afterCreate?.type === 'form-sync') {
      try {
        const workflow = await setupTemplateFormSync({
          documentId: result.documentId,
          tableIdsByTitle: result.tableIdsByTitle,
          setup: template.afterCreate,
        })
        setFeedback(workflow.published
          ? `Private event form connected: ${workflow.public_url}`
          : 'Private event form draft created')
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Failed to connect the private event form')
      }
    }
    return true
  }, [
    createTable,
    kitableChildrenIndex,
    kitableTemplateDialogState,
    setError,
    setFeedback,
    setActiveResourcePath,
    upsertWorkspaceTab,
    workspaceTree,
  ])

  const handleKitableTableDeleted = useCallback((kitablePath: string, tableId: number) => {
    const tabId = buildKitableWorkspaceTabId(kitablePath)
    const tab = workspaceTabs.find((item) => item.id === tabId)
    if (tab?.type !== 'table' || tab.tableId !== tableId) return
    const fallbackTable = (kitableChildrenIndex.tablesByKitablePath[kitablePath] || [])
      .filter((table) => table.id !== tableId)
      .sort((left, right) => left.order - right.order)[0]
    const activate = activeWorkspaceTabId === tabId
    if (fallbackTable) {
      upsertWorkspaceTab({
        id: tabId,
        type: 'table',
        title: getKitableWorkspaceTabTitle(kitablePath),
        kitablePath,
        tableId: fallbackTable.id,
        format: 'data',
      }, { activate })
      return
    }
    upsertWorkspaceTab({
      id: tabId,
      type: 'workflow',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
    }, { activate })
  }, [activeWorkspaceTabId, kitableChildrenIndex.tablesByKitablePath, upsertWorkspaceTab, workspaceTabs])

  const handleKitableDashboardDeleted = useCallback((kitablePath: string, dashboardId: string) => {
    const tabId = buildKitableWorkspaceTabId(kitablePath)
    const tab = workspaceTabs.find((item) => item.id === tabId)
    if (tab?.type !== 'dashboard' || tab.dashboardId !== dashboardId) return
    const fallbackTable = [...(kitableChildrenIndex.tablesByKitablePath[kitablePath] || [])]
      .sort((left, right) => left.order - right.order)[0]
    const activate = activeWorkspaceTabId === tabId
    if (fallbackTable) {
      upsertWorkspaceTab({
        id: tabId,
        type: 'table',
        title: getKitableWorkspaceTabTitle(kitablePath),
        kitablePath,
        tableId: fallbackTable.id,
        format: 'data',
      }, { activate })
      return
    }
    upsertWorkspaceTab({
      id: tabId,
      type: 'workflow',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
    }, { activate })
  }, [activeWorkspaceTabId, kitableChildrenIndex.tablesByKitablePath, upsertWorkspaceTab, workspaceTabs])

  const handleKitableWorkflowDeleted = useCallback((kitablePath: string, workflowId: string) => {
    const tabId = buildKitableWorkspaceTabId(kitablePath)
    const tab = workspaceTabs.find((item) => item.id === tabId)
    if (tab?.type !== 'workflow' || tab.workflowId !== workflowId) return
    const fallbackTable = [...(kitableChildrenIndex.tablesByKitablePath[kitablePath] || [])]
      .sort((left, right) => left.order - right.order)[0]
    const activate = activeWorkspaceTabId === tabId
    if (fallbackTable) {
      upsertWorkspaceTab({
        id: tabId,
        type: 'table',
        title: getKitableWorkspaceTabTitle(kitablePath),
        kitablePath,
        tableId: fallbackTable.id,
        format: 'data',
      }, { activate })
      return
    }
    upsertWorkspaceTab({
      id: tabId,
      type: 'workflow',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
    }, { activate })
  }, [activeWorkspaceTabId, kitableChildrenIndex.tablesByKitablePath, upsertWorkspaceTab, workspaceTabs])

  // Group A helpers: virtual leaves use their domain APIs directly. The
  // file-level kitable tab survives inner table/workflow deletion and falls
  // back to another view in the same file.
  const { renameKitableTableLeaf, deleteKitableTableLeaf } = useKitableTableLeafActions({
    kitableChildrenIndex,
    activeResourcePath,
    setActiveResourcePath,
    onTableDeleted: handleKitableTableDeleted,
    setError,
    setFeedback,
  })
  const { renameKitableDashboardLeaf, deleteKitableDashboardLeaf } = useKitableDashboardLeafActions({
    kitableChildrenIndex,
    activeResourcePath,
    setActiveResourcePath,
    onDashboardDeleted: handleKitableDashboardDeleted,
    setError,
    setFeedback,
  })
  // Group A: virtual `workflow://` leaves under a .kitable. Like the table
  // leaves they have no on-disk path — delete is routed through the
  // workflow API, which also emits WORKFLOW_CHANGED_EVENT so the tree
  // refresh is implicit.
  const { renameKitableWorkflowLeaf, deleteKitableWorkflowLeaf } = useKitableWorkflowLeafActions({
    kitableChildrenIndex,
    activeResourcePath,
    setActiveResourcePath,
    onWorkflowDeleted: handleKitableWorkflowDeleted,
    setError,
    setFeedback,
  })

  // Group A: dispatch by virtual-table-leaf so the menu's "..." actions hit the
  // data-document API for synthesized leaves and the existing workspace tree
  // actions for real on-disk files.
  const handleTreeNodeDelete = useCallback(
    (node: WorkspaceTreeNode) => {
      if (parseKitableTableVirtualPath(node.path)) {
        void deleteKitableTableLeaf(node)
        return
      }
      if (parseKitableDashboardVirtualPath(node.path)) {
        void deleteKitableDashboardLeaf(node)
        return
      }
      if (parseKitableWorkflowVirtualPath(node.path)) {
        void deleteKitableWorkflowLeaf(node)
        return
      }
      void deleteDocumentNode(node)
    },
    [
      deleteDocumentNode,
      deleteKitableDashboardLeaf,
      deleteKitableWorkflowLeaf,
      deleteKitableTableLeaf,
    ],
  )
  const handleTreeNodeRename = useCallback(
    (node: WorkspaceTreeNode, nextTitle: string) => {
      if (parseKitableTableVirtualPath(node.path)) {
        void renameKitableTableLeaf(node, nextTitle)
        return
      }
      if (parseKitableDashboardVirtualPath(node.path)) {
        void renameKitableDashboardLeaf(node, nextTitle)
        return
      }
      if (parseKitableWorkflowVirtualPath(node.path)) {
        void renameKitableWorkflowLeaf(node, nextTitle)
        return
      }
      void renameWorkspaceNode(node, nextTitle)
    },
    [
      renameKitableDashboardLeaf,
      renameKitableWorkflowLeaf,
      renameKitableTableLeaf,
      renameWorkspaceNode,
    ],
  )

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
  const openWorkflowModeDialogForContext = useCallback(
    (
      kitablePath: string | null,
      context: WorkflowRouteContext | null,
      tableOptions: WorkflowRouteContext[] = context ? [context] : [],
    ) => {
      setAutoCreateModeError(null)
      setAutoCreateModeBusyKind(null)
      setAutoCreateModeBusyTemplateId(undefined)
      setAutoCreateModeState({ kitablePath, context, tableOptions })
    },
    [],
  )

  const openWorkflowCreateModeDialog = useCallback(
    (node: WorkspaceTreeNode) => {
      // Case 1: .kitable container row.
      const isKitableContainer = node.type === 'file'
        && !node.virtual
        && node.name.toLowerCase().endsWith('.kitable')
      if (isKitableContainer) {
        const kitablePath = node.path
        const docId = kitableChildrenIndex.docIdByKitablePath[kitablePath]
        if (!docId) {
          setError(t('errors.kitableNotFound'))
          return
        }
        const tables = kitableChildrenIndex.tablesByKitablePath[kitablePath] || []
        if (tables.length === 0) {
          setError(t('errors.kitableNoTables'))
          return
        }
        const tableOptions = tables.map((table) => ({
            documentId: String(docId),
            tableId: String(table.id),
            tableName: table.title || node.title || t('tabs.untitledTable'),
        }))
        openWorkflowModeDialogForContext(kitablePath, tableOptions[0], tableOptions)
        return
      }
      // Case 2: virtual `table://` leaf (legacy entry).
      const parsed = parseKitableTableVirtualPath(node.path)
      if (!parsed) return
      const docId = kitableChildrenIndex.docIdByKitablePath[parsed.kitablePath]
      if (!docId) {
        setError(t('errors.parentKitableNotFound'))
        return
      }
      const summary = (kitableChildrenIndex.tablesByKitablePath[parsed.kitablePath] || []).find(
        (table) => table.id === parsed.tableId,
      )
      const tableName = summary?.title || node.title || t('tabs.untitledTable')
      openWorkflowModeDialogForContext(parsed.kitablePath, {
        documentId: String(docId),
        tableId: String(parsed.tableId),
        tableName,
      })
    },
    [kitableChildrenIndex, openWorkflowModeDialogForContext, setError, t],
  )

  const createTableFromKitableSidebar = useCallback(async (kitablePath: string) => {
    const result = await createTableInsideKitable(kitablePath)
    if (!result || result.tableId == null) {
      return
    }
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'table',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      tableId: result.tableId,
      format: 'data',
    })
    setActiveResourcePath(kitablePath)
    void kitableChildrenIndex.refresh()
  }, [createTableInsideKitable, kitableChildrenIndex, setActiveResourcePath, t, upsertWorkspaceTab])

  const createDashboardFromKitableSidebar = useCallback(async (kitablePath: string) => {
    const sourceTableId = activeWorkspaceTab?.type === 'table'
      && activeWorkspaceTab.kitablePath === kitablePath
      ? activeWorkspaceTab.tableId
      : undefined
    try {
      const created = await createDataDashboardByPath(kitablePath, sourceTableId)
      await kitableChildrenIndex.refresh()
      openKitableDashboard(kitablePath, created.dashboard.id)
      notify.success(t('feedback.dashboardCreated'))
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t('errors.createDashboardFailed'),
      )
    }
  }, [
    activeWorkspaceTab,
    kitableChildrenIndex,
    openKitableDashboard,
    setError,
    t,
  ])

  const createWorkflowFromKitableSidebar = useCallback((kitablePath: string) => {
    const name = kitablePath.split('/').pop() || kitablePath
    const parentPath = kitablePath.includes('/')
      ? kitablePath.slice(0, kitablePath.lastIndexOf('/'))
      : ''
    openWorkflowCreateModeDialog({
      type: 'file',
      path: kitablePath,
      filePath: kitablePath,
      name,
      title: name.replace(/\.kitable$/i, ''),
      format: 'data',
      parentPath,
      children: [],
    })
  }, [openWorkflowCreateModeDialog])

  const createFormFromKitableSidebar = useCallback((kitablePath: string) => {
    const documentId = kitableChildrenIndex.docIdByKitablePath[kitablePath]
    if (!documentId) {
      setError(t('errors.kitableNotFound'))
      return
    }
    const initialTableId = activeWorkspaceTab?.type === 'table'
      && activeWorkspaceTab.kitablePath === kitablePath
      ? activeWorkspaceTab.tableId
      : kitableChildrenIndex.tablesByKitablePath[kitablePath]?.[0]?.id
    setFormSyncCreateState({ kitablePath, documentId, initialTableId })
  }, [activeWorkspaceTab, kitableChildrenIndex, setError, t])

  const handleFormSyncCreated = useCallback((workflow: FormSyncWorkflow) => {
    const state = formSyncCreateState
    if (!state) return
    void kitableChildrenIndex.refresh()
    openKitableWorkflow(state.kitablePath, workflow.id)
    setFormSyncCreateState(null)
  }, [formSyncCreateState, kitableChildrenIndex, openKitableWorkflow])

  const closeWorkflowCreateModeDialog = useCallback(() => {
    setAutoCreateModeState(null)
    setAutoCreateModeError(null)
    setAutoCreateModeBusyKind(null)
    setAutoCreateModeBusyTemplateId(undefined)
  }, [])

  const handleWorkflowCreateModeSelect = useCallback(
    (choice: WorkspaceWorkflowCreateModeChoice) => {
      const state = autoCreateModeState
      if (!state) return
      const selectedContext = choice.context || state.context
      if (choice.kind === 'chat') {
        // AI mode runs in the standalone /workflow route — close the dialog
        // synchronously and let the router show the chat-first surface.
        // state.context may be null (unbound creation); openWorkflowRoute
        // already accepts null and persists it as the route context.
        closeWorkflowCreateModeDialog()
        openWorkflowRoute(selectedContext, { mode: 'ai' })
        return
      }
      // Both the template and scratch branches end with the same post-create
      // routing: attach the new workflow under the source .kitable tab when
      // we have a kitablePath, otherwise open the standalone editor. Extract
      // it so the scratch branch doesn't have to duplicate ~20 lines of tree
      // metadata + tab juggling.
      const finalizeCreatedWorkflow = (def: WorkflowDefinition) => {
        if (state.kitablePath) {
                                                      
                                            
          workspaceTree.updateTreeMetadata((current) => {
            if (current.collapsed.includes(state.kitablePath!)) return current
            return { ...current, collapsed: [...current.collapsed, state.kitablePath!] }
          })
          upsertWorkspaceTab({
            id: buildKitableWorkspaceTabId(state.kitablePath),
            type: 'workflow',
            title: getKitableWorkspaceTabTitle(state.kitablePath),
            kitablePath: state.kitablePath,
            workflowId: def.id,
          })
          setActiveResourcePath(buildKitableWorkflowVirtualPath(state.kitablePath, def.id))
        } else {
          // Unbound creation (no parent kitable). Route through the
          // standalone /workflow editor so the user can pick a table
          // inside the trigger config panel.
          openWorkflowRoute(null, { mode: 'editor' })
        }
        void kitableChildrenIndex.refresh()
        closeWorkflowCreateModeDialog()
      }
      if (choice.kind === 'scratch') {
        // Scratch branch: POST an empty draft directly. Seed
        // trigger.type with record_created regardless of context — the
        // drawer's event dropdown defaults to this anyway, and the
        // create endpoint's allowedTriggerTypes gate rejects an empty
        // string (only def.Validate() is lenient about it, which the
        // gate runs before). documentId/tableId still get the
        // delayed-binding empty when no context is pinned; the user
        // wires those from the trigger panel.
        setAutoCreateModeError(null)
        setAutoCreateModeBusyKind('scratch')
        setAutoCreateModeBusyTemplateId(undefined)
        void (async () => {
          try {
            const def = await createWorkflow({
              name: 'Untitled workflow',
              description: '',
              enabled: false,
              trigger: {
                type: 'record_created',
                documentId: selectedContext?.documentId ?? '',
                tableId: selectedContext?.tableId ?? '',
              },
              action: {
                type: 'send_email',
                connectionId: '',
                to: 'you@example.com',
                subject: { parts: [{ kind: 'text', text: 'New record' }] },
                body: { parts: [{ kind: 'text', text: 'A new record was created.' }] },
              },
            })
            finalizeCreatedWorkflow(def)
          } catch (err) {
            setAutoCreateModeError(err instanceof Error ? err.message : t('errors.createWorkflowFailed'))
            setAutoCreateModeBusyKind(null)
          }
        })()
        return
      }
      // Template branch: POST the workflow immediately. When state.context
      // is null the template helper skips schema fetch and produces a draft
      // (Trigger.TableID/Type empty) — the backend now accepts this and the
      // user binds the table afterwards from the trigger config panel.
      setAutoCreateModeError(null)
      setAutoCreateModeBusyKind('template')
      setAutoCreateModeBusyTemplateId(choice.template.id)
      void (async () => {
        try {
          const { workflow: def, unresolvedFieldNames } = await createWorkflowFromMode(choice.template, selectedContext)
          // Same one-shot handoff the inline launcher uses (see
          // WorkflowLauncher.handleTemplateSelect). The post-creation
          // editor reads this key to decide whether to show the
          // "template fields couldn't be bound" banner.
          if (unresolvedFieldNames.length > 0) {
            try {
              window.sessionStorage.setItem(
                `kition:workflow:template-unresolved:${def.id}`,
                JSON.stringify(unresolvedFieldNames),
              )
            } catch {
              // sessionStorage may be unavailable in some Electron
              // contexts; the banner is non-critical so we silently skip.
            }
          }
          finalizeCreatedWorkflow(def)
        } catch (err) {
          setAutoCreateModeError(err instanceof Error ? err.message : t('errors.createWorkflowFailed'))
          setAutoCreateModeBusyKind(null)
          setAutoCreateModeBusyTemplateId(undefined)
        }
      })()
    },
    [
      autoCreateModeState,
      closeWorkflowCreateModeDialog,
      kitableChildrenIndex,
      setActiveResourcePath,
      upsertWorkspaceTab,
      workspaceTree,
      t,
    ],
  )

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
    if (!activeDataWorkspaceTabPath) {
      return
    }
    const nextTableId =
      tableAgentContextByPath[activeDataWorkspaceTabPath]?.activeTable?.id
      ?? activeDataWorkspaceTableId
    const nextOriginLabel = String(
      tableAgentContextByPath[activeDataWorkspaceTabPath]?.activeTable?.title ||
        tableAgentContextByPath[activeDataWorkspaceTabPath]?.activeDocument
          ?.title ||
        '',
    ).trim()
    setLastTableAgentTarget((current) => {
      if (
        current.documentPath === activeDataWorkspaceTabPath &&
        current.tableId === nextTableId &&
        current.originLabel === nextOriginLabel
      ) {
        return current
      }
      return {
        documentPath: activeDataWorkspaceTabPath,
        tableId: nextTableId,
        originLabel: nextOriginLabel,
      }
    })
  }, [activeDataWorkspaceTabPath, activeDataWorkspaceTableId, tableAgentContextByPath])

  useEffect(() => {
    if (!browserResolvedDocumentPath) {
      return
    }
    const nextOriginLabel = String(
      activeBrowserTab?.originLabel ||
        tableAgentContextByPath[browserResolvedDocumentPath]?.activeTable
          ?.title ||
        tableAgentContextByPath[browserResolvedDocumentPath]?.activeDocument
          ?.title ||
        lastTableAgentTarget.originLabel ||
        '',
    ).trim()
    setLastTableAgentTarget((current) => {
      if (
        current.documentPath === browserResolvedDocumentPath &&
        current.tableId === browserResolvedTableId &&
        current.originLabel === nextOriginLabel
      ) {
        return current
      }
      return {
        documentPath: browserResolvedDocumentPath,
        tableId: browserResolvedTableId,
        originLabel: nextOriginLabel,
      }
    })
  }, [
    activeBrowserTab?.originLabel,
    browserResolvedDocumentPath,
    browserResolvedTableId,
    lastTableAgentTarget.originLabel,
    tableAgentContextByPath,
  ])

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

  useEffect(() => {
    const syncSnapshotIntoTabs = (snapshot: WorkspaceBrowserTabPayload) => {
      const matchedIds = findWorkspaceBrowserTabIdsForSnapshot(
        workspaceTabsRef.current,
        snapshot,
      )
      for (const tabId of matchedIds) {
        updateWorkspaceTab(tabId, (tab) =>
          applyWorkspaceBrowserSessionSnapshot(tab, snapshot),
        )
      }
    }

    const unregisterGenericWeb = registerBrowserSessionStateHandler('generic-web', (state) => {
      setBrowserNavState((current) =>
        current?.provider === state.provider &&
        current.url === state.url &&
        current.canGoBack === state.canGoBack &&
        current.canGoForward === state.canGoForward &&
        current.isLoading === state.isLoading
          ? current
          : state,
      )
      syncSnapshotIntoTabs({
        provider: 'generic-web',
        title: state.title,
        url: state.url,
      })
    })

    return () => {
      unregisterGenericWeb()
    }
  }, [updateWorkspaceTab])

  useEffect(() => {
    setBrowserNavState(null)
    setBrowserPanelPhase(
      activeBrowserTab && !String(activeBrowserTab.url || '').trim()
        ? 'empty'
        : 'loading',
    )
    // Only re-seed the phase when switching tabs, not on every live URL update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrowserTab?.id])

  useEffect(() => {
    let cancelled = false

    const resetBrowserTabReattachBudget = (tabId: string) => {
      if (!tabId) {
        return
      }
      browserTabReattachCountRef.current = {
        ...browserTabReattachCountRef.current,
        [tabId]: 0,
      }
    }

    const shouldReattachBrowserTab = (
      status?: Awaited<ReturnType<typeof getBrowserSessionStatus>> | null,
    ) => {
      if (!activeBrowserTab) {
        return false
      }
      const expectedUrl = String(activeBrowserTab.url || '').trim()
      const liveUrl = String(status?.page_url || '').trim()
      // A browser tab with no requested URL and no live page stays on the empty
      // state with its BrowserView detached — never reattach it.
      if (!expectedUrl && !liveUrl) {
        return false
      }
      if (!status) {
        return true
      }
      if (!status.panel_visible) {
        return true
      }
      if (expectedUrl && !liveUrl) {
        return true
      }
      return false
    }

    const refreshBrowserTabSnapshot = async () => {
      if (!activeBrowserTab) {
        return
      }
      const status = await getBrowserSessionStatus({
        provider: activeBrowserTab.provider,
        profile_id: activeBrowserTab.profileId,
        host: activeBrowserTab.host,
      }).catch(() => null)
      if (!status || cancelled) {
        return
      }
      if (status.panel_visible) {
        resetBrowserTabReattachBudget(activeBrowserTab.id)
        setBrowserPanelPhase('ready')
      }
      updateWorkspaceTab(activeBrowserTab.id, (tab) =>
        applyWorkspaceBrowserSessionSnapshot(tab, {
          provider: activeBrowserTab.provider,
          profile_id: activeBrowserTab.profileId,
          host: activeBrowserTab.host,
          title: status.page_title,
          url: status.page_url,
        }),
      )
      return status
    }

    const syncBrowserTab = async () => {
      if (workflowOpen) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({ provider: activeBrowserTab?.provider || 'generic-web' }).catch(() => null)
        if (!cancelled) {
          setBrowserPanelPhase('empty')
        }
        return
      }
      if (!activeBrowserTab) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({ provider: 'generic-web' }).catch(() => null)
        return
      }

      const currentStatus = await refreshBrowserTabSnapshot()
      const sameTabActive =
        lastSyncedBrowserTabIdRef.current === activeBrowserTab.id
      const targetURL = String(activeBrowserTab.url || '').trim()
      const liveURL = String(currentStatus?.page_url || '').trim()
      // No requested URL and no live page → keep the BrowserView detached and
      // show the empty state until the user (or agent) navigates somewhere.
      if (!targetURL && !(sameTabActive && liveURL)) {
        lastSyncedBrowserTabIdRef.current = ''
        await hideBrowserSessionPanel({
          provider: activeBrowserTab.provider,
        }).catch(() => null)
        if (!cancelled) {
          setBrowserPanelPhase('empty')
        }
        return
      }
      const keepLivePage = sameTabActive && Boolean(liveURL)
      const resolvedURL = resolveWorkspaceBrowserTabNavigationURL({
        tabURL: keepLivePage ? '' : activeBrowserTab.url,
        liveURL: currentStatus?.page_url,
      })
      const request = {
        provider: activeBrowserTab.provider,
        profile_id: activeBrowserTab.profileId,
        host: activeBrowserTab.host,
        url: resolvedURL,
      }
      const attachedStatus = await ensureBrowserSessionWindow(request)
      if (cancelled) {
        return
      }
      resetBrowserTabReattachBudget(activeBrowserTab.id)
      lastSyncedBrowserTabIdRef.current = activeBrowserTab.id
      updateWorkspaceTab(activeBrowserTab.id, (tab) => {
        return applyWorkspaceBrowserSessionSnapshot(tab, {
          provider: activeBrowserTab.provider,
          profile_id: activeBrowserTab.profileId,
          host: activeBrowserTab.host,
          title: attachedStatus.page_title,
          url: attachedStatus.page_url,
        })
      })
      await setBrowserSessionHostLayout({
        ...request,
        leftInset: effectiveSidebarWidth,
        topInset: measureBrowserTabTopInset(),
        rightInset:
          workspaceAgentOpen
            ? agentSidebarWidth
            : 0,
      })
      if (!cancelled) {
        setBrowserPanelPhase(
          attachedStatus.panel_visible === false ? 'loading' : 'ready',
        )
      }
    }

    void syncBrowserTab().catch(() => {
      // The embedded browser is unavailable (e.g. dev/web build without the
      // desktop bridge); show the explanatory placeholder instead of a spinner.
      if (!cancelled) {
        setBrowserPanelPhase('unavailable')
      }
    })

    if (workflowOpen || !activeBrowserTab) {
      return () => {
        cancelled = true
      }
    }

    const handleResize = () => {
      void syncBrowserTab().catch(() => {
        // Ignore browser tab resize sync errors.
      })
    }
    const pollTimer = window.setInterval(() => {
      void (async () => {
        const status = await refreshBrowserTabSnapshot().catch(() => null)
        if (cancelled || !activeBrowserTab) {
          return
        }
        if (!shouldReattachBrowserTab(status)) {
          return
        }
        const reattachCount =
          browserTabReattachCountRef.current[activeBrowserTab.id] || 0
        if (reattachCount >= WORKSPACE_BROWSER_TAB_REATTACH_LIMIT) {
          return
        }
        browserTabReattachCountRef.current = {
          ...browserTabReattachCountRef.current,
          [activeBrowserTab.id]: reattachCount + 1,
        }
        await syncBrowserTab()
      })().catch(() => {
        // Ignore browser tab polling errors.
      })
    }, 1500)
    window.addEventListener('resize', handleResize)
    return () => {
      cancelled = true
      window.clearInterval(pollTimer)
      window.removeEventListener('resize', handleResize)
    }
  }, [
    activeBrowserTab,
    agentSidebarWidth,
    workflowOpen,
    effectiveSidebarWidth,
    workspaceAgentOpen,
    updateWorkspaceTab,
  ])

  const handleBrowserNavigate = useCallback(
    async (address: string) => {
      const tab = activeBrowserTabRef.current
      const target = String(address || '').trim()
      if (!tab || !target) {
        return
      }
      const request = {
        provider: tab.provider,
        profile_id: tab.profileId,
        host: tab.host,
      }
      setBrowserPanelPhase('loading')
      const status = await ensureBrowserSessionWindow({
        ...request,
        address: target,
      }).catch(() => null)
      if (!status) {
        setBrowserPanelPhase('unavailable')
        return
      }
      lastSyncedBrowserTabIdRef.current = tab.id
      setBrowserNavState(getBrowserSessionPanelState(tab.provider, status))
      updateWorkspaceTab(tab.id, (current) =>
        applyWorkspaceBrowserSessionSnapshot(current, {
          provider: tab.provider,
          profile_id: tab.profileId,
          host: tab.host,
          title: status.page_title,
          url: status.page_url,
        }),
      )
      await setBrowserSessionHostLayout({
        ...request,
        leftInset: effectiveSidebarWidth,
        topInset: measureBrowserTabTopInset(),
        rightInset: workspaceAgentOpen ? agentSidebarWidth : 0,
      }).catch(() => null)
      setBrowserPanelPhase(status.panel_visible === false ? 'loading' : 'ready')
    },
    [agentSidebarWidth, effectiveSidebarWidth, updateWorkspaceTab, workspaceAgentOpen],
  )

  const runBrowserNavCommand = useCallback(
    async (
      command: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>,
    ) => {
      const tab = activeBrowserTabRef.current
      if (!tab) {
        return
      }
      const status = await command({
        provider: tab.provider,
        profile_id: tab.profileId,
        host: tab.host,
      }).catch(() => null)
      if (!status) {
        return
      }
      setBrowserNavState(getBrowserSessionPanelState(tab.provider, status))
    },
    [],
  )

  const handleBrowserBack = useCallback(() => {
    void runBrowserNavCommand(browserSessionGoBack)
  }, [runBrowserNavCommand])
  const handleBrowserForward = useCallback(() => {
    void runBrowserNavCommand(browserSessionGoForward)
  }, [runBrowserNavCommand])
  const handleBrowserReload = useCallback(() => {
    void runBrowserNavCommand(browserSessionReload)
  }, [runBrowserNavCommand])
  const handleBrowserStop = useCallback(() => {
    void runBrowserNavCommand(browserSessionStop)
  }, [runBrowserNavCommand])

  const browserToolbarStatus = useMemo(
    () => ({
      url: browserNavState?.url || String(activeBrowserTab?.url || ''),
      canGoBack: browserNavState?.canGoBack,
      canGoForward: browserNavState?.canGoForward,
      isLoading: browserNavState?.isLoading,
    }),
    [
      activeBrowserTab?.url,
      browserNavState?.url,
      browserNavState?.canGoBack,
      browserNavState?.canGoForward,
      browserNavState?.isLoading,
    ],
  )

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

  const handleTableAgentContextChange = useCallback((context: {
    documentPath: string
    activeDocument: DataDocument | null
    activeTable: DataTable | null
    onTableChanged?: () => Promise<void> | void
  }) => {
    const path = String(context.documentPath || '').trim()
    if (!path) {
      return
    }

    setTableAgentContextByPath((current) => {
      if (!context.activeDocument || !context.activeTable) {
        const existing = current[path]
        if (!existing) {
          return current
        }
        return {
          ...current,
          [path]: {
            ...existing,
            onTableChanged: undefined,
          },
        }
      }

      return {
        ...current,
        [path]: {
          activeDocument: context.activeDocument,
          activeTable: context.activeTable,
          onTableChanged: context.onTableChanged,
        },
      }
    })
  }, [])

  useEffect(() => {
    if (!hasTableAgentTarget || !tableAgentDocumentPath) {
      return
    }
    const needsHydration =
      !tableAgentContext?.activeDocument ||
      !tableAgentContext?.activeTable ||
      (
        activeWorkspaceTab?.type === 'browser' &&
        Boolean(browserResolvedTableId) &&
        tableAgentContext.activeTable.id !== browserResolvedTableId
      )
    if (!needsHydration) {
      return
    }

    let cancelled = false
    void refreshTableAgentContextByPath(
      tableAgentDocumentPath,
      activeWorkspaceTab?.type === 'browser'
        ? browserResolvedTableId
        : activeDataWorkspaceTableId || tableAgentContext?.activeTable?.id || null,
    ).catch(() => {
      if (!cancelled) {
        // Keep the current workspace usable even if lazy table-agent hydration fails.
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    activeWorkspaceTab?.type,
    activeDataWorkspaceTableId,
    browserResolvedTableId,
    hasTableAgentTarget,
    refreshTableAgentContextByPath,
    tableAgentContext?.activeDocument,
    tableAgentContext?.activeTable,
    tableAgentDocumentPath,
  ])

  useEffect(() => {
    if (!workspaceAgentOpen) {
      setWorkspaceAgentHistoryOpen(false)
      return
    }
    void refreshAgentSessions()
  }, [refreshAgentSessions, workspaceAgentOpen])

  const autoCreatedAgentChatRef = useRef(false)
  useEffect(() => {
    if (!workspaceAgentOpen) {
      autoCreatedAgentChatRef.current = false
      return
    }
    if (activeWorkspaceAgentSession || agentSessions.length > 0) {
      return
    }
    if (autoCreatedAgentChatRef.current) {
      return
    }
    autoCreatedAgentChatRef.current = true
    void createNewAgentChat({
      focusTab: true,
      documentPaths: activeWorkspaceDocumentPath ? [activeWorkspaceDocumentPath] : [],
    })
  }, [
    workspaceAgentOpen,
    activeWorkspaceAgentSession,
    agentSessions.length,
    createNewAgentChat,
    activeWorkspaceDocumentPath,
  ])

  useEffect(() => {
    const root = document.documentElement
    if (workspaceAgentOpen) {
      root.style.setProperty('--workspace-agent-sidebar-width', `${agentSidebarWidth}px`)
    } else {
      root.style.removeProperty('--workspace-agent-sidebar-width')
    }
    return () => {
      root.style.removeProperty('--workspace-agent-sidebar-width')
    }
  }, [workspaceAgentOpen, agentSidebarWidth])

  useEffect(() => {
    if (!pendingFocusedSessionId) {
      return
    }
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)
    setClosedWorkspaceAgentSessionIds((current) => {
      if (!current.has(pendingFocusedSessionId)) return current
      const next = new Set(current)
      next.delete(pendingFocusedSessionId)
      return next
    })
    setActiveWorkspaceAgentSessionId(pendingFocusedSessionId)
    clearPendingFocusedSessionId()
  }, [clearPendingFocusedSessionId, pendingFocusedSessionId])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    setClosedWorkspaceAgentSessionIds(new Set())
    const stored = readWorkspaceAgentActiveSessionId(rootPath)
    setActiveWorkspaceAgentSessionId(stored && stored > 0 ? stored : null)
    // Switch the active chat focus when the workspace root changes so the
    // right-side tab bar tracks the workspace instead of leaking the previous
    // workspace's pinned session. agentSessions reset is handled inside
    // useWorkspaceAgent — here we just rehydrate the per-rootPath focus.
  }, [rootPath])

  useEffect(() => {
    if (activeWorkspaceAgentSessionId) {
      const exists = openWorkspaceAgentSessions.some(
        (session) => session.id === activeWorkspaceAgentSessionId,
      )
      if (exists) {
        return
      }
    }
    setActiveWorkspaceAgentSessionId(openWorkspaceAgentSessions[0]?.id || null)
  }, [activeWorkspaceAgentSessionId, openWorkspaceAgentSessions])

  useEffect(() => {
    writeWorkspaceAgentActiveSessionId(rootPath, activeWorkspaceAgentSessionId)
  }, [activeWorkspaceAgentSessionId, rootPath])

  useEffect(() => {
    if (!activeWorkspaceAgentSession) {
      return
    }
    void openAgentSession(activeWorkspaceAgentSession)
  }, [activeWorkspaceAgentSession, openAgentSession])

  const openWorkspaceBrowserFromRequest = useCallback(
    (request: AgentBrowserOpenRequest) => {
      if (!WEB_BROWSER_ENABLED) {
        return
      }
      dispatchOpenWorkspaceBrowserTab(
        buildAgentBrowserTabPayload({
          provider:
            (request.provider as BrowserSessionProvider) || 'generic-web',
          taskMode: agentTurnContextRef.current.taskMode,
          host: request.host,
          url: request.url,
          query: request.query,
          activeDocument: tableAgentContext?.activeDocument ?? null,
          documentPath: tableAgentDocumentPath,
          activeTable: tableAgentContext?.activeTable ?? null,
        }),
      )
    },
    [tableAgentContext, tableAgentDocumentPath],
  )

  const runAgentBrowserPreflight = useCallback(async (content: string) => {
    if (!WEB_BROWSER_ENABLED) {
      return undefined
    }
    const target = extractAgentWebTarget(content)
    if (!target) {
      return undefined
    }

    const provider: BrowserSessionProvider = 'generic-web'
    setAgentBrowserEnabled(true)
    setBrowserPanelPhase('loading')
    dispatchOpenWorkspaceBrowserTab(
      buildAgentBrowserTabPayload({
        provider,
        taskMode: agentTurnContextRef.current.taskMode,
        host: target.host,
        url: target.url,
        activeDocument: tableAgentContext?.activeDocument ?? null,
        documentPath: tableAgentDocumentPath,
        activeTable: tableAgentContext?.activeTable ?? null,
      }),
    )

    const context = await preflightAgentBrowserContext({
      target,
      provider,
    })
    setBrowserPanelPhase('ready')
    return context
  }, [setAgentBrowserEnabled, tableAgentContext, tableAgentDocumentPath])
  prepareAgentBrowserContextRef.current = runAgentBrowserPreflight

  const browserAutoOpenSessionRef = useRef<number | null>(null)
  const browserAutoOpenEventIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeWorkspaceAgentSession) {
      return
    }
    const sessionId = activeWorkspaceAgentSession.id
    let latest: AgentEvent | null = null
    for (const event of agentEvents[sessionId] || []) {
      if (event.event_type === 'browser.open_required') {
        latest = event
      }
    }
    const latestId = latest ? latest.id : null
    // First view of a session seeds the handled id, so opening/switching/reloading
    // never reopens a historical handoff — only events that arrive live auto-open.
    if (browserAutoOpenSessionRef.current !== sessionId) {
      browserAutoOpenSessionRef.current = sessionId
      browserAutoOpenEventIdRef.current = latestId
      return
    }
    if (!latest || browserAutoOpenEventIdRef.current === latestId) {
      return
    }
    browserAutoOpenEventIdRef.current = latestId
    openWorkspaceBrowserFromRequest(readBrowserOpenRequest(latest))
  }, [activeWorkspaceAgentSession, agentEvents, openWorkspaceBrowserFromRequest])

  const browserAutoContinueEventKeysRef = useRef(new Set<string>())
  useEffect(() => {
    if (
      !activeWorkspaceAgentSession ||
      !activeBrowserTab ||
      (browserPanelPhase !== 'ready' && browserPanelPhase !== 'unavailable') ||
      agentBusySessions.has(activeWorkspaceAgentSession.id)
    ) {
      return
    }

    const sessionId = activeWorkspaceAgentSession.id
    const continuation = findLatestBrowserContinuationRequest(
      agentEvents[sessionId] || [],
    )
    if (!continuation) {
      return
    }
    const { eventId: latestEventId, request: latestRequest } = continuation

    const eventKey = `${sessionId}:${latestEventId}`
    if (browserAutoContinueEventKeysRef.current.has(eventKey)) {
      return
    }
    const requestedHost = resolveWorkspaceBrowserHost({
      host: latestRequest.host,
      url: latestRequest.url,
    })
    const activeHost = resolveWorkspaceBrowserHost(activeBrowserTab)
    if (requestedHost && requestedHost !== activeHost) {
      return
    }

    browserAutoContinueEventKeysRef.current.add(eventKey)
    setAgentBrowserEnabled(true)
    const originalRequest = latestRequest.originalRequest || ''
    const attempt = latestRequest.autoContinueAttempt || 1
    if (
      browserPanelPhase !== 'ready' ||
      latestRequest.autoContinueExhausted ||
      attempt > MAX_BROWSER_AUTO_CONTINUE_ATTEMPTS
    ) {
      sendAgentContextAction(sessionId, {
        content: buildBrowserUnavailablePrompt(originalRequest),
        browserAutoContinue: true,
        browserAutoContinueAttempt: attempt,
        browserAutoContinueFinal: true,
        browserOriginalRequest: originalRequest,
      })
      return
    }

    void extractAgentBrowserContinuationContext({
      target: {
        provider: activeBrowserTab.provider,
        profileId: activeBrowserTab.profileId,
        host: activeBrowserTab.host,
      },
      request: latestRequest,
    }).then((browserContext) => {
      sendAgentContextAction(sessionId, {
        content: buildBrowserAutoContinuePrompt(originalRequest),
        browserAutoContinue: true,
        browserAutoContinueAttempt: attempt,
        browserOriginalRequest: originalRequest,
        browserContext,
      })
    }).catch(() => {
      sendAgentContextAction(sessionId, {
        content: buildBrowserUnavailablePrompt(originalRequest),
        browserAutoContinue: true,
        browserAutoContinueAttempt: attempt,
        browserAutoContinueFinal: true,
        browserOriginalRequest: originalRequest,
      })
    })
  }, [
    activeBrowserTab,
    activeWorkspaceAgentSession,
    agentBusySessions,
    agentEvents,
    browserPanelPhase,
    sendAgentContextAction,
    setAgentBrowserEnabled,
  ])

  function toggleActiveAgentPanel() {
    if (workspaceAgentOpen) {
      setWorkspaceAgentOpen(false)
      setWorkspaceAgentHistoryOpen(false)
      return
    }

    const sessionToRestore = activeWorkspaceAgentSession
      || openWorkspaceAgentSessions[0]
      || agentSessions[0]
      || null
    if (sessionToRestore) {
      setClosedWorkspaceAgentSessionIds((current) => {
        if (!current.has(sessionToRestore.id)) return current
        const next = new Set(current)
        next.delete(sessionToRestore.id)
        return next
      })
      setActiveWorkspaceAgentSessionId(sessionToRestore.id)
    }
    setWorkspaceAgentOpen(true)
  }

  async function handleCreateWorkspaceAgentChat() {
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)
    await createNewAgentChat({
      focusTab: true,
      documentPaths: activeWorkspaceDocumentPath ? [activeWorkspaceDocumentPath] : [],
    })
  }

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

  function handleWorkspaceAgentSessionSelect(sessionId: number) {
    setWorkspaceAgentOpen(true)
    setWorkspaceAgentHistoryOpen(false)
    setClosedWorkspaceAgentSessionIds((current) => {
      if (!current.has(sessionId)) return current
      const next = new Set(current)
      next.delete(sessionId)
      return next
    })
    setActiveWorkspaceAgentSessionId(sessionId)
  }

  function handleCloseWorkspaceAgentChats(sessionIds: number[]) {
    const closingIds = new Set(sessionIds)
    if (!closingIds.size) return
    const activeIndex = openWorkspaceAgentSessions.findIndex(
      (session) => session.id === activeWorkspaceAgentSessionId,
    )
    const remainingSessions = openWorkspaceAgentSessions.filter(
      (session) => !closingIds.has(session.id),
    )

    setClosedWorkspaceAgentSessionIds((current) => {
      const next = new Set(current)
      closingIds.forEach((sessionId) => next.add(sessionId))
      return next
    })

    if (activeWorkspaceAgentSessionId && closingIds.has(activeWorkspaceAgentSessionId)) {
      const nextIndex = Math.min(Math.max(activeIndex, 0), remainingSessions.length - 1)
      setActiveWorkspaceAgentSessionId(remainingSessions[nextIndex]?.id || null)
    }
    if (!remainingSessions.length) {
      setWorkspaceAgentOpen(false)
      setWorkspaceAgentHistoryOpen(false)
    }
  }

  async function handleSubmitWorkspaceFolder() {
    const created = await createFolder(createMenuFolder, workspaceFolderName)
    if (!created) {
      return
    }
    setWorkspaceFolderDialogOpen(false)
    setWorkspaceFolderName('')
  }

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

  async function sendWorkspaceAgentMessage(sessionId: number) {
    const sources = agentLocalSources[sessionId] || []
    const pathReference = extractAgentLocalPathReference(agentDrafts[sessionId] || '')
    if (!sources.length && pathReference) {
      const source = await addLocalAnalysisSource(pathReference)
      if (!source) {
        return
      }
      sendAiComposerMessage(sessionId, appendAgentLocalSource(sources, source))
      return
    }
    sendAiComposerMessage(sessionId)
  }

  const workspaceRightPane = workspaceAgentOpen ? (
    <Suspense fallback={null}>
      <WorkspaceAgentSidebar
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
              onSend: () => void sendWorkspaceAgentMessage(activeWorkspaceAgentSession.id),
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
              .forEach((tab) => closeWorkspaceTab(tab.id))
            const keeper = workspaceTabs.find((t) => t.id === tabId)
            if (workflowOpen && keeper && keeper.type !== 'workflow') {
              onCloseWorkflow?.()
            }
          },
          onCloseAll: () => {
            workspaceTabs.forEach((tab) => closeWorkspaceTab(tab.id))
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
              closeWorkspaceTab(tab.id)
            })
          },
          onCloseLeft: (tabId) => {
            const index = workspaceTabs.findIndex((tab) => tab.id === tabId)
            if (index <= 0) {
              return
            }
            workspaceTabs
              .slice(0, index)
              .forEach((tab) => closeWorkspaceTab(tab.id))
          },
          onCloseRight: (tabId) => {
            const index = workspaceTabs.findIndex((tab) => tab.id === tabId)
            if (index < 0) {
              return
            }
            workspaceTabs
              .slice(index + 1)
              .forEach((tab) => closeWorkspaceTab(tab.id))
          },
          onCloseReadOnly: () => {
            workspaceTabs.forEach((tab) => {
              if (
                tab.type === 'file-viewer'
                || tab.type === 'gallery'
                || tab.type === 'browser-sites'
              ) {
                closeWorkspaceTab(tab.id)
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
            onOpenChange={(open) => {
              setWorkspaceFolderDialogOpen(open)
              if (!open) {
                setWorkspaceFolderName('')
              }
            }}
            onValueChange={setWorkspaceFolderName}
            onSubmit={() => void handleSubmitWorkspaceFolder()}
          />
        </Suspense>
      ) : null}
      {documentTemplateDialogState ? (
        <Suspense fallback={null}>
          <DocumentTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) setDocumentTemplateDialogState(null)
            }}
            onCreate={handleCreateDocumentFromTemplate}
          />
        </Suspense>
      ) : null}
      {kitableTemplateDialogState ? (
        <Suspense fallback={null}>
          <KitableTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) setKitableTemplateDialogState(null)
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
              if (!open) setFormSyncCreateState(null)
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
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            setTableFileImportState({ file, folder: tableFileImportFolderRef.current || undefined })
          }
          event.currentTarget.value = ''
        }}
      />
      {tableFileImportState ? (
        <Suspense fallback={null}>
          <TableFileImportDialog
            open
            file={tableFileImportState.file}
            target={{ kind: 'new_document', folder: tableFileImportState.folder }}
            onOpenChange={(open) => {
              if (!open) setTableFileImportState(null)
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
                setDocumentTemplateDialogState({ folderOverride: createMenuFolder })
              },
              onCreateFolder: () => {
                workspaceTree.setCreateMenuOpen(false)
                setWorkspaceFolderName('')
                setWorkspaceFolderDialogOpen(true)
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
                  void (async () => {
                    const captured = kitableCreateContext
                    const result = await createTableInsideKitable(captured)
                    setKitableCreateContext(null)
                    if (result) {
                                                                  
                                                            
                                 
                      workspaceTree.updateTreeMetadata((current) => {
                        if (current.collapsed.includes(captured)) return current
                        return { ...current, collapsed: [...current.collapsed, captured] }
                      })
                      upsertWorkspaceTab({
                        id: buildKitableWorkspaceTabId(captured),
                        type: 'table',
                        title: getKitableWorkspaceTabTitle(captured),
                        kitablePath: captured,
                        tableId: result.tableId,
                        format: 'data',
                      })
                      void kitableChildrenIndex.refresh()
                    }
                  })()
                  return
                }
                workspaceTree.setCreateMenuOpen(false)
                setKitableTemplateDialogState({ folderOverride: createMenuFolder })
              },
              onImportTableFile: createMenuVariant === 'workspace'
                ? () => {
                    workspaceTree.setCreateMenuOpen(false)
                    tableFileImportFolderRef.current = createMenuFolder
                    tableFileImportInputRef.current?.click()
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
              onCreateBoard: () => {
                onCloseProfile?.()
                void handleCreateBoard()
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
                    onTableAgentContextChange: handleTableAgentContextChange,
                    onCreateWorkflow: createWorkflowFromKitableSidebar,
                    onOpenWorkflow: openKitableWorkflow,
                    onOpenGlobalWorkflow: openWorkspaceWorkflow,
                    onOpenWorkflows: () => openWorkspaceWorkflow(),
                    onCreateDocument: () => {
                      setDocumentTemplateDialogState({ folderOverride: '' })
                    },
                    onCreateTable: () => {
                      setKitableTemplateDialogState({ folderOverride: '' })
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
