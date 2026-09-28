import {
  AlertCircle,
  ChevronLeft,
  FileText,
  LoaderCircle,
  Mail,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { ConnectionModal, formFromConnection } from '@/features/connections/ConnectionsSettingsPanel'
import { listChannels, listConnections, type ChannelSchema, type ConnectionView } from '@/api/connections'
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  patchWorkflow,
  type WorkflowDefinition,
} from '@/api/workflows'
import { WORKFLOW_ENABLED_CHANGED_EVENT } from '@/features/workflow/lib/workflowEvents'
import {
  actionInlineError,
  actionNodeDescription,
  actionStatus,
  actionTitleI18nKey,
  cloneAddRecord,
  draftToValidationPatch,
  emptyDraft,
  fallbackSchemaFromWorkflow,
  filterNodeDescription,
  filterNodeStatus,
  filterNodeTitle,
  parseIdAsNumber,
  toDraft,
  triggerLabel,
  triggerStatus,
  triggerTitleI18nKey,
  workflowStatus,
} from '@/features/workflow/lib/workflowDraft'
import {
  Field,
  FlowLine,
  StatusPill,
  StepCard,
} from '@/features/workflow/pages/WorkflowHomePagePrimitives'
import {
  WorkflowHomeActionsMenu,
  type WorkflowDetailView,
} from '@/features/workflow/pages/WorkflowHomeActionsMenu'
import {
  InlineRunHistory,
  LogsView,
  formatAbsoluteTime,
  relativeTime,
} from '@/features/workflow/pages/WorkflowHomePageRunHistory'
import {
  ConfirmDialog,
  type ConfirmState,
} from '@/features/workflow/pages/WorkflowHomePageConfirm'
import { StatusBannerSlot } from '@/features/workflow/pages/WorkflowHomePageStatusBanner'
import { WorkflowHomeLauncher } from '@/features/workflow/components/launcher/WorkflowHomeLauncher'
import {
  WorkspaceWorkflowCreateModeDialog,
  type WorkspaceWorkflowCreateModeChoice,
} from '@/features/workspace/components/WorkspaceWorkflowCreateModeDialog'
import { WorkflowStatusToggle } from '@/features/workflow/components/WorkflowStatusToggle'
import { SampleRowPicker } from '@/features/workflow/components/SampleRowPicker'
import { BodyTemplateEditor } from '@/features/workflow/components/BodyTemplateEditor'
import { TemplateTokenInput } from '@/features/workflow/components/TemplateTokenInput'
import type { BodyPart, BodyTemplate, TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { TriggerTableSelect } from '@/features/workflow/components/TriggerTableSelect'
import { TriggerRequiredFieldsPanel } from '@/features/workflow/components/TriggerRequiredFieldsPanel'
import { ScheduledTriggerPropertiesPanel } from '@/features/workflow/components/ScheduledTriggerPropertiesPanel'
import { AddRecordActionPropertiesPanel } from '@/features/workflow/components/AddRecordActionPropertiesPanel'
import { RecordActionPropertiesPanel } from '@/features/workflow/components/RecordActionPropertiesPanel'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { useWorkflowRuns } from '@/features/workflow/hooks/useWorkflowRuns'
import { useWorkflowSendTest } from '@/features/workflow/hooks/useWorkflowSendTest'
import { useWorkflowNodeTest } from '@/features/workflow/hooks/useWorkflowNodeTest'
import { useWorkflowModeDialogState } from '@/features/workflow/hooks/useWorkflowModeDialogState'
import { useWorkflowLauncherState } from '@/features/workflow/hooks/useWorkflowLauncherState'
import { useConnectionsModalState } from '@/features/workflow/hooks/useConnectionsModalState'
import { useUnresolvedTemplateFields } from '@/features/workflow/hooks/useUnresolvedTemplateFields'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { useTableSchemaCache } from '@/features/workflow/hooks/useTableSchemaCache'
import { useWorkflowDraftState } from '@/features/workflow/hooks/useWorkflowDraftState'
import { useWorkflowGraphState } from '@/features/workflow/hooks/useWorkflowGraphState'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/registry/ui/dialog'

import { WorkflowCanvas } from '@/features/workflow/canvas/WorkflowCanvas'
import { WorkflowDetailTopbar, WorkflowIndexTopbar } from '@/features/workflow/pages/home/WorkflowHomeTopbar'
import { WorkflowBuildBanner, WorkflowRunTestHeader, WorkflowUnresolvedTemplateBanner } from '@/features/workflow/pages/home/WorkflowHomeBanners'
import { WorkflowCanvasNodes } from '@/features/workflow/pages/home/WorkflowCanvasNodes'
import { WorkflowDrawerSaveRow, WorkflowSaveBar } from '@/features/workflow/pages/home/WorkflowSaveBar'
import { WorkflowTriggerDrawerPanel } from '@/features/workflow/pages/home/WorkflowTriggerDrawerPanel'
import {
  WorkflowAddRecordDrawerPanel,
  WorkflowEmailDrawerPanel,
  WorkflowRecordActionDrawerPanel,
  type WorkflowActionPanelContext,
} from '@/features/workflow/pages/home/WorkflowActionDrawerPanels'
import { WorkflowEmptyState } from '@/features/workflow/pages/home/WorkflowEmptyState'
import { NodeCard, type NodeStatus } from '@/features/workflow/canvas/NodeCard'
import { DrawerField, DrawerSection, PropertiesDrawer } from '@/features/workflow/drawer/PropertiesDrawer'
import { publishWorkflowNodeAskAI } from '@/features/workflow/lib/askAiBridge'
import { publishWorkflowAiBuildOpen } from '@/features/workflow/lib/aiChatBridge'
import {
  STREAMING_WORKFLOW_ID,
  isAiBuildLocked,
  phaseLabelKey,
  statusForPhase,
  type AiBuildPhase,
} from '@/features/workflow/lib/aiBuildPreview'
import type { WorkflowBuildStatus } from '@/features/workflow/types'
import { openWorkflowRoute } from '@/features/workflow/lib/openWorkflowRoute'
import {
  compileFilterExpression,
  FilterPropertiesPanel,
  parseFilterExpression,
  type FilterCondition,
} from '@/features/workflow/components/FilterPropertiesPanel'
import { normaliseGraph } from '@/features/workflow/hooks/useWorkflowGraph'
import { useWorkflowTriggerEditor } from '@/features/workflow/hooks/useWorkflowTriggerEditor'
import { useWorkflowGraphEditing } from '@/features/workflow/hooks/useWorkflowGraphEditing'
import { buildTriggerTableOptions, buildWorkflowSavePatch, countRunsByStatus, filterDryRunSample } from '@/features/workflow/lib/workflowPatches'
import { useWorkflowValidation } from '@/features/workflow/hooks/useWorkflowValidation'
import { dryRunFilter, retryWorkflowRun } from '@/api/workflows'


type StatusFilter = 'all' | 'active' | 'failing' | 'disabled'
export interface WorkflowHomePageProps {
  /** When provided and the id matches a loaded workflow, pre-select it.
   *  Wired by the Build page's "Open in Workflows" handoff. */
  initialSelectedId?: string
  /** When provided, the page opens with the create-mode chooser dialog
   *  showing immediately. Used by the WorkflowRoute when the URL is
   *  `/workflow/new` without a pre-bound table context. */
  initialModeDialogOpen?: boolean
  /** When the page is mounted inside a DocTab the tab bar owns close; hide
   *  the in-page X to avoid stacked close affordances. Defaults to false
   *  for the legacy modal mount. */
  hideClose?: boolean
  /** When mounted from inside a .kitable tab the empty-state launcher copy
   *  can reference the scope by name. Pure display — the launcher actions
   *  themselves no longer bind to a table at creation time (delayed
   *  binding). Undefined → no scope label is shown. */
  scopedKitablePath?: string
  /** Workspace root the page is mounted under. Forwarded to
   *  useWorkflowTableLabels so the trigger-table picker stays in lockstep
   *  with the file-tree's kitable index — without this the picker would
   *  fetch every data document across all workspaces and tableId
   *  collisions would silently overwrite the in-scope rows. Undefined for
   *  the legacy modal mount, which never carried a workspace handle. */
  rootPath?: string
  onClose?: () => void
  /** When the upstream WorkflowRoute is mid-AI-build it passes the streaming
   *  preview through. The home page pins the synthetic workflow at the top of
   *  its list, force-selects it, and locks all destructive controls until the
   *  row gets replaced by the real persisted workflow (signalled via the
   *  preview's `createdId` field). Null while no build is in flight. */
  streamingPreview?: StreamingPreview | null
  /** Called once after the streaming preview lands a real `createdId` and the
   *  home page has refreshed its list + switched selection to the persisted
   *  id. The route uses this hook to release its useWorkflowBuild state so
   *  the synthetic row disappears in the next render. */
  onStreamingComplete?: (realWorkflowId: string) => void
}

/**
 * Shape WorkflowRoute hands to WorkflowHomePage while the AI build pipeline
 * is in flight. `workflow` is the synthesized preview (already wrapped via
 * withStreamingId), `createdId` flips from null → real uuid when the
 * workflow.created event arrives.
 */
export interface StreamingPreview {
  workflow: WorkflowDefinition | null
  status: WorkflowBuildStatus
  phase: AiBuildPhase
  prompt: string
  error: string | null
  schema: TableSchema | null
  createdId: string | null
}

export function WorkflowHomePage({ initialSelectedId, initialModeDialogOpen = false, hideClose = false, scopedKitablePath, rootPath, onClose, streamingPreview, onStreamingComplete }: WorkflowHomePageProps) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [latestRuns, setLatestRuns] = useState<Record<string, WorkflowRunRecord | null>>({})
  const [selectedId, setSelectedId] = useState(initialSelectedId || '')
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')
  const [savingDraft, setSavingDraft] = useState(false)
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  // Group C: mode chooser dialog state. With delayed table binding the
  const launcher = useWorkflowLauncherState({
    // Arrow wrappers — `refresh` is a useCallback declared below this
    // hook call, so we read it lazily through closure to avoid the
    // temporal-dead-zone bind that a direct property reference would
    // hit at construction time.
    refresh: () => refresh(),
    onCreated: (id) => setSelectedId(id),
  })

  // dialog can run either bound (context resolved by an upstream
  // `table://` leaf handoff) or unbound (the caller — top "Create"
  // button, empty-state CTA, or WorkflowRoute opening
  // /workflow/new — has no pre-bound table; the user picks one inside
  // the trigger config panel after the editor opens). The dialog's
  // open/context/busy/error state lives in useWorkflowModeDialogState
  // (WF-C1g) so the page sees one fat object instead of five setters.
  const modeDialog = useWorkflowModeDialogState({
    initialOpen: initialModeDialogOpen,
    onBeforeOpen: () => launcher.clearError(),
  })
  const { labels: tableLabels } = useWorkflowTableLabels(rootPath)
  // Lazy schema cache. ensure() short-circuits on hit and dedupes
  // concurrent fetches on the same tableId — see useTableSchemaCache.
  const schemaCache = useTableSchemaCache()
  const schemaByTableId = schemaCache.schemas
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const { t } = useTranslation('workflow')
  const [activeTab, setActiveTab] = useState<WorkflowDetailView>('configuration')
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [channels, setChannels] = useState<ChannelSchema[]>([])
  // The connection-settings modal's open / editing-id pair lives in
  // useConnectionsModalState (WF-C1i) — three different call sites used
  // to repeat the same two-setter dance.
  const connectionsModal = useConnectionsModalState()
  // selectedNodeId is the canvas-level selection. Drives which panel the
  // Drawer renders. Defaults to the action node since that's where 95% of
  // editing happens; clicking the trigger card switches it.
  const [selectedNodeId, setSelectedNodeId] = useState<string>('')
  const [drawerOpen, setDrawerOpen] = useState(true)
  // Graph state owns the v2 nodes list (currently trigger + optional
  // filters + primary action). The legacy draft above still holds the
  // editable trigger/action fields; filter chain + graph dirty live in
  // useWorkflowGraphState (WF-C1j5) — see the hook call below `selected`.
  const [retryInFlight, setRetryInFlight] = useState<string | null>(null)
  const [runStatusFilter, setRunStatusFilter] = useState<'all' | 'ok' | 'error' | 'skipped'>('all')
  const [filterDryRun, setFilterDryRun] = useState<{ matched: boolean; reason?: string } | null>(null)
  const [filterDryRunLoading, setFilterDryRunLoading] = useState(false)
  // Template-binding banner: the launcher stashes unresolved-field names
  // under `sessionStorage[kition:workflow:template-unresolved:<id>]` when a
  // body's field_ref_by_name part couldn't bind to the schema. The hook
  // drains the key on first selection (one-shot) and exposes the list
  // plus a dismiss callback — see useUnresolvedTemplateFields for the
  // contract.
  const unresolvedTemplate = useUnresolvedTemplateFields(selectedId)

  const runTest = useWorkflowSendTest()
  const sendTest = useWorkflowSendTest()
  const nodeTest = useWorkflowNodeTest()

  // While the upstream WorkflowRoute is mid-AI-build, pin its synthesized
  // workflow at the head of the list. Real rows that happen to share its
  // id (impossible — the sentinel is `__streaming__`) are dropped just in
  // case. Every read path that used `workflows` directly switches to
  // `effectiveWorkflows`; stat counters (active / failing / scoped active)
  // still read the un-augmented `workflows` so the synthetic row doesn't
  // pollute their numbers.
  const effectiveWorkflows = useMemo(() => {
    const synth = streamingPreview?.workflow
    if (!synth) return workflows
    return [synth, ...workflows.filter((w) => w.id !== STREAMING_WORKFLOW_ID)]
  }, [workflows, streamingPreview])

  // Lock derivation: true while the synthetic row is the active selection AND
  // the AI is still mutating it. Every destructive control (Save bar, enable
  // toggle, delete, run-test, name input, drawer panels) checks this.
  const streamLocked = Boolean(
    streamingPreview?.workflow
      && selectedId === STREAMING_WORKFLOW_ID
      && isAiBuildLocked(streamingPreview.status),
  )

  // Force selection onto the synthetic row whenever a fresh preview lands.
  // Skip once createdId has arrived so the handoff effect below can swap
  // selectedId to the persisted id without us yanking it back.
  useEffect(() => {
    if (!streamingPreview?.workflow) return
    if (streamingPreview.createdId) return
    if (selectedId === STREAMING_WORKFLOW_ID) return
    setSelectedId(STREAMING_WORKFLOW_ID)
  }, [streamingPreview, selectedId])

  // Mount-only chat-drawer wakeup. Republishing on every events tick would
  // clobber whatever the user has started typing in the agent composer.
  const aiChatPublishedRef = useRef(false)
  useEffect(() => {
    if (aiChatPublishedRef.current) return
    if (!streamingPreview?.prompt) return
    publishWorkflowAiBuildOpen({
      prompt: streamingPreview.prompt,
      workflow: { id: '', name: streamingPreview.workflow?.name ?? '' },
      tableName: streamingPreview.schema?.name,
    })
    aiChatPublishedRef.current = true
  }, [streamingPreview])

  // Hand-off: workflow.created fired → refresh the list (the row is now in
  // the API), point selectedId at the real id, then notify the route so it
  // can release its useWorkflowBuild state. prevHandoffRef stops us from
  // re-running this when streamingPreview ticks again with the same
  // createdId.
  const prevHandoffRef = useRef<string | null>(null)
  useEffect(() => {
    const realId = streamingPreview?.createdId
    if (!realId) return
    if (prevHandoffRef.current === realId) return
    prevHandoffRef.current = realId
    void refresh().then(() => {
      setSelectedId(realId)
      onStreamingComplete?.(realId)
    })
    // refresh is declared further down as a useCallback; the closure pulls
    // the live version, so leaving it out of deps is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingPreview?.createdId])

  const selected = useMemo(
    () => effectiveWorkflows.find((workflow) => workflow.id === selectedId) || null,
    [effectiveWorkflows, selectedId],
  )

  // Draft editing pair + derivations live in useWorkflowDraftState
  // (WF-C1j4). The hook syncs draft from `selected` on swap, exposes
  // draft-only validation / dirty / dirtyFields, and hands the page
  // setDraft + setOriginalDraft so per-field handlers and the Save
  // path can mutate / mark-clean as before. Graph dirty is unioned in
  // below to drive the SaveBar.
  const {
    draft,
    originalDraft,
    setDraft,
    setOriginalDraft,
    validation,
    draftDirty,
    draftDirtyFields,
  } = useWorkflowDraftState(selected)

  // Graph state (filter chain) — parallel to draft state. The hook
  // owns the (graphNodes, originalGraphNodes) pair, syncs both from
  // `selected` on swap, and exposes a graphDirty bit the page unions
  // with draftDirty before driving SaveBar.
  const {
    graphNodes,
    originalGraphNodes,
    setGraphNodes,
    setOriginalGraphNodes,
    graphDirty,
  } = useWorkflowGraphState(selected)

  // Streaming-id rows aren't on the backend yet — null the id out so the
  // runs / validate / history hooks short-circuit instead of 404-ing.
  const selectedBackendId = selected && selected.id !== STREAMING_WORKFLOW_ID ? selected.id : null
  const selectedRuns = useWorkflowRuns(selectedBackendId, Boolean(selectedBackendId))
  // §A7: per-node test runs are tagged manual.test so we drop them from the
  // user-facing run history. They still write a server-side history row, but
  // the UI presents only "real" trigger runs to avoid noise.
  const visibleRuns = useMemo(
    () => selectedRuns.runs.filter((run) => run.triggerEvent !== 'manual.test'),
    [selectedRuns.runs],
  )

  // Union draft + graph dirty bits so SaveBar reflects either source.
  const isDirty = draftDirty || graphDirty
  const dirtyFields = useMemo(() => {
    const fields = [...draftDirtyFields]
    if (graphDirty) fields.push('Workflow')
    return fields
  }, [draftDirtyFields, graphDirty])
  const serverValidation = useWorkflowValidation(
    selectedBackendId,
    selected ? draftToValidationPatch(draft, selected.action) : null,
  )
  // Server-side issues override the local check when they conflict — the
  // server has access to connection state and the schema, so its "error"
  // is authoritative. Warning-level server issues don't block Save.
  const hasValidationErrors = Object.keys(validation).length > 0 || serverValidation.errors.length > 0
  const activeCount = useMemo(() => workflows.filter((item) => item.enabled).length, [workflows])
  // Workflows visible in the current scope: when this page is mounted under
  // a .kitable tab, the list and counts should reflect that kitable only.
  // The mapping goes via `tableLabels[trigger.tableId].documentPath` so we
  // don't need a second API round-trip — labels already carry the path.
  // Workflows whose trigger is unbound (draft) or whose table is missing
  // from labels (race during initial load) are excluded from the scoped
  // view; they remain visible from the global Workflows tab.
  const scopedWorkflows = useMemo(() => {
    if (!scopedKitablePath) return workflows
    return workflows.filter((workflow) => {
      const tableId = workflow.trigger?.tableId || ''
      const label = tableId ? tableLabels[tableId] : null
      return label?.documentPath === scopedKitablePath
    })
  }, [workflows, scopedKitablePath, tableLabels])
  const scopedActiveCount = useMemo(
    () => scopedWorkflows.filter((item) => item.enabled).length,
    [scopedWorkflows],
  )

  const refresh = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const items = await listWorkflows()
      setWorkflows(items)
      setSelectedId((current) => {
        if (items.some((item) => item.id === current)) return current
        // No left rail to pick from — if there's no pre-selected id from the
        // caller (DocTab / WorkflowRoute detail mode), keep selection empty
        // so the user sees the launcher empty-state instead of being dropped
        // into the first workflow's editor unexpectedly.
        if (!initialSelectedId) return ''
        return items[0]?.id || ''
      })
      setStatus('done')
      void Promise.all(
        items.map(async (item) => {
          const runs = await listWorkflowRuns(item.id, 1).catch(() => [])
          return [item.id, runs[0] || null] as const
        }),
      ).then((entries) => setLatestRuns(Object.fromEntries(entries)))
    } catch (requestError) {
      setStatus('error')
      setError(requestError instanceof Error ? requestError.message : 'Failed to load workflows')
    }
  }, [initialSelectedId])

  // Launcher actions used to route through the table picker first. With
  // delayed table binding they fire immediately: AI hands off to the
  // standalone /workflow route in `ai` mode; scratch and template create
  // a draft workflow directly (Trigger.TableID/Type empty) — the user
  // binds the table from the trigger config panel afterwards. The `mode`
  // kind opens the create-mode chooser dialog with null context.
  // (The three launcher actions — scratch / template / agent — and the
  // related busy/error state now live in useWorkflowLauncherState, see
  // the hook call above.)

  // Group C: dialog-driven choice. The dialog only opens with null context
  // on this page (`/workflow/new` route or top "Create" button) — the
  // upstream table-picker handoff path that used to set modeDialog.context
  // was removed alongside the picker. The hook keeps the context field on
  // its result type so a future caller can hand in a pre-bound context
  // without rewiring the dialog props.

  const refreshLatestRun = useCallback(async (workflowId: string) => {
    const runs = await listWorkflowRuns(workflowId, 1).catch(() => [])
    setLatestRuns((current) => ({ ...current, [workflowId]: runs[0] || null }))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    function onWorkflowEnabledChanged(event: Event) {
      const detail = (event as CustomEvent<{ workflowId?: string; enabled?: boolean }>).detail
      if (!detail?.workflowId || typeof detail.enabled !== 'boolean') return
      setWorkflows((current) => current.map((workflow) => (
        workflow.id === detail.workflowId
          ? { ...workflow, enabled: detail.enabled as boolean }
          : workflow
      )))
    }
    window.addEventListener(WORKFLOW_ENABLED_CHANGED_EVENT, onWorkflowEnabledChanged)
    return () => {
      window.removeEventListener(WORKFLOW_ENABLED_CHANGED_EVENT, onWorkflowEnabledChanged)
    }
  }, [])

  const refreshConnections = useCallback(async () => {
    const [nextChannels, nextConnections] = await Promise.all([listChannels(), listConnections()])
    setChannels(nextChannels)
    setConnections(nextConnections.filter((connection) => connection.channel === 'email_smtp'))
  }, [])

  useEffect(() => {
    void refreshConnections().catch(() => undefined)
  }, [refreshConnections])

  // Listen for the Ask-AI side-effect: when the agent's configure_smtp_connection
  // tool finishes, useWorkspaceAgent broadcasts kition:connections:changed.
  // Reload the dropdown so the new/updated row is immediately selectable.
  // If the tool ALSO attached the connection to this workflow (sees
  // workflow_attached + workflowId in the event), pull the new
  // connectionId into the draft so the user doesn't have to manually
  // pick from the dropdown after the AI finishes.
  useEffect(() => {
    function onConnectionsChanged(event: Event) {
      void refreshConnections().catch(() => undefined)
      const detail = (event as CustomEvent<{ connectionId?: string; workflowId?: string; workflowAttached?: boolean }>).detail
      if (!detail?.workflowAttached) return
      if (!detail.connectionId) return
      // Only auto-update the draft if it targets the workflow the
      // user is currently viewing — otherwise the broadcast was for a
      // different doc tab and silently rewriting this draft would be
      // confusing.
      if (selected && detail.workflowId && detail.workflowId === selected.id) {
        setDraft((current) => ({ ...current, connectionId: detail.connectionId || current.connectionId }))
        setOriginalDraft((current) => ({ ...current, connectionId: detail.connectionId || current.connectionId }))
      }
    }
    window.addEventListener('kition:connections:changed', onConnectionsChanged)
    return () => {
      window.removeEventListener('kition:connections:changed', onConnectionsChanged)
    }
  }, [refreshConnections, selected])

  // Tracks the last selectedId the sync effect below saw. When the user
  // PATCHes a workflow (e.g. changes the trigger table from the drawer)
  // `selected` gets a new object reference but `selectedId` stays the same
  // — we still want to refresh the draft + graph from server state, but
  // we must NOT reset the canvas selection or focus would silently jump
  // back to the action node after every trigger edit.
  const previousSelectedIdRef = useRef<string>('')

  useEffect(() => {
    setError('')
    setExpandedRunId(null)
    runTest.reset()
    sendTest.reset()
    // Draft and graph are synced to `selected` inside their respective
    // hooks (useWorkflowDraftState, useWorkflowGraphState). This effect
    // only handles the page-local UI bits: error, expanded-run, test
    // results, canvas selection, active tab.
    if (selected) {
      if (previousSelectedIdRef.current !== selectedId) {
        setSelectedNodeId(selected.action.nodeId || 'action_1')
        // Only mark the id as "settled" after we actually have the
        // workflow data to point at. Otherwise initialSelectedId set
        // before listWorkflows resolves would land here once with
        // selected=null (which goes to the else branch) and stamp the
        // ref, and the follow-up render with the resolved workflow
        // would see the ref already equal to selectedId and skip
        // setSelectedNodeId — leaving the canvas with no node selected.
        previousSelectedIdRef.current = selectedId
      }
    } else {
      setActiveTab('configuration')
      setSelectedNodeId('')
    }
  }, [selectedId, selected])

  useEffect(() => {
    if (!selected) return
    const documentId = selected.trigger.documentId
    const tableId = selected.trigger.tableId
    if (!documentId || !tableId) return
    // ensure() short-circuits internally on a cache hit, so we don't
    // need to gate on schemaByTableId[tableId] here.
    void schemaCache.ensure(documentId, tableId, tableLabels[tableId]?.tableName)
  }, [selected, tableLabels, schemaCache])

  // Lazy-fetch the add_record action's target-table schema. Lives separate
  // from the trigger schema effect above because the target can (and often
  // does) point at a different table than the trigger source — most
  // visibly for the "scheduled_time → Add record" Feishu template, where
  // the trigger has no table at all and the action's target is the sole
  // bound table on the workflow.
  useEffect(() => {
    if (!selected || !['add_record', 'lookup_record'].includes(selected.action.type)) return
    const targetTableId = selected.action.type === 'lookup_record'
      ? draft.lookupRecord?.targetTableId || selected.action.lookupRecord?.targetTableId
      : draft.addRecord?.targetTableId || selected.action.addRecord?.targetTableId
    if (!targetTableId) return
    // documentId may come from the workflow itself or from tableLabels (the
    // server doesn't always denormalise it onto action.addRecord).
    const targetDocumentId = selected.action.type === 'lookup_record'
      ? draft.lookupRecord?.targetDocumentId || selected.action.lookupRecord?.targetDocumentId || tableLabels[targetTableId]?.documentId
      : draft.addRecord?.targetDocumentId || selected.action.addRecord?.targetDocumentId
      || tableLabels[targetTableId]?.documentId
    if (!targetDocumentId) return
    void schemaCache.ensure(targetDocumentId, targetTableId, tableLabels[targetTableId]?.tableName)
  }, [selected, draft.addRecord, draft.lookupRecord, tableLabels, schemaCache])

  const guardSwitchTo = useCallback((next: () => void) => {
    if (!isDirty) {
      next()
      return
    }
    setConfirm({
      title: t('confirms.discardChangesSwitch.title'),
      message: t('confirms.discardChangesSwitch.message'),
      confirmLabel: t('confirms.discardChangesSwitch.confirm'),
      destructive: true,
      onConfirm: next,
    })
  }, [isDirty, t])

  async function saveSelected() {
    if (!selected || !isDirty || hasValidationErrors) return
    // Streaming sentinel never points at a real backend row. Bail before any
    // network call so a stray Save click can't 404 against /workflows/__streaming__.
    if (selected.id === STREAMING_WORKFLOW_ID) return
    setSavingDraft(true)
    setError('')
    try {
      const updated = await patchWorkflow(selected.id, buildWorkflowSavePatch({ draft, selected, graphNodes, tableLabels }))
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
      setOriginalDraft(toDraft(updated))
      setDraft(toDraft(updated))
      const graph = normaliseGraph(updated)
      setGraphNodes(graph.nodes)
      setOriginalGraphNodes(graph.nodes)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save workflow')
    } finally {
      setSavingDraft(false)
    }
  }

  function discardChanges() {
    if (!selected) return
    setDraft(toDraft(selected))
    setGraphNodes(originalGraphNodes)
    setError('')
  }

  async function toggleSelected(next: boolean) {
    if (!selected) return
    if (selected.id === STREAMING_WORKFLOW_ID) return
    setTogglingEnabled(true)
    setError('')
    try {
      const updated = await patchWorkflow(selected.id, { enabled: next })
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update workflow')
    } finally {
      setTogglingEnabled(false)
    }
  }

  async function runSelectedTest() {
    if (!selected || validation.to) return
    if (selected.id === STREAMING_WORKFLOW_ID) return
    await runTest.send(selected.id, draft.to)
    await refreshLatestRun(selected.id)
  }

  async function runSelectedTestWithRow(values: Record<string, unknown>) {
    if (!selected || validation.to) return
    // Pass the picked record's values through to the send-test endpoint so
    // the rendered preview uses real data instead of the AI sample. Same
    // run-history path otherwise (TriggerEvent="manual.test"); the user
    // can tell pick-driven runs apart from AI ones by the body content.
    await runTest.send(selected.id, { to: draft.to, triggerFields: values })
    await refreshLatestRun(selected.id)
  }

  async function sendInlineTest() {
    if (!selected || validation.to) return
    await sendTest.send(selected.id, draft.to)
    await refreshLatestRun(selected.id)
  }

  const ensureSchemaLoaded = useCallback(
    (documentId: string, tableId: string) => schemaCache.ensure(documentId, tableId, tableLabels[tableId]?.tableName),
    [schemaCache, tableLabels],
  )
  const triggerEditor = useWorkflowTriggerEditor({
    selected,
    tableLabels,
    ensureSchema: ensureSchemaLoaded,
    setWorkflows,
    setSavingDraft,
    setError,
    setConfirm,
  })

  function requestDelete() {
    if (!selected) return
    if (selected.id === STREAMING_WORKFLOW_ID) return
    setConfirm({
      title: t('confirms.deleteWorkflow.title'),
      message: t('confirms.deleteWorkflow.message', { name: selected.name || t('confirms.deleteWorkflow.nameFallback') }),
      confirmLabel: t('confirms.deleteWorkflow.confirm'),
      destructive: true,
      onConfirm: () => { void removeSelected() },
    })
  }

  async function removeSelected() {
    if (!selected) return
    if (selected.id === STREAMING_WORKFLOW_ID) return
    const removingId = selected.id
    setDeleting(true)
    setError('')
    try {
      await deleteWorkflow(removingId)
      setWorkflows((current) => current.filter((item) => item.id !== removingId))
      setSelectedId('')
      setDraft(emptyDraft())
      setOriginalDraft(emptyDraft())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('errors.deleteWorkflow'))
    } finally {
      setDeleting(false)
    }
  }

  const handleClose = useCallback(() => {
    const doClose = () => {
      if (onClose) {
        onClose()
        return
      }
      window.history.replaceState(window.history.state, '', '/documents')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
    }
    if (isDirty) {
      setConfirm({
        title: t('confirms.discardChangesClose.title'),
        message: t('confirms.discardChangesClose.message'),
        confirmLabel: t('confirms.discardChangesClose.confirm'),
        destructive: true,
        onConfirm: doClose,
      })
      return
    }
    doClose()
  }, [isDirty, onClose, t])

  const handleRefresh = useCallback(() => {
    guardSwitchTo(() => { void refresh() })
  }, [guardSwitchTo, refresh])

  const handleSelectListItem = useCallback((id: string) => {
    if (id === selectedId) return
    guardSwitchTo(() => {
      setSelectedId(id)
      setActiveTab('configuration')
    })
  }, [guardSwitchTo, selectedId])

  // Reset filter dry-run state when the selected node changes — the
  // result is scoped to a single filter node and stale otherwise.
  useEffect(() => {
    setFilterDryRun(null)
  }, [selectedNodeId])

  const {
    deleteNode: handleDeleteNode,
    duplicateNode: handleDuplicateNode,
    setNodeDisabled: handleToggleDisabledNode,
    insertAt: handleInsertAt,
    deleteSelectedNode: handleDeleteSelectedNode,
  } = useWorkflowGraphEditing({
    selected,
    graphNodes,
    setGraphNodes,
    selectedNodeId,
    setSelectedNodeId,
    setDraft,
    setDrawerOpen,
    setConfirm,
    setError,
    onDeleteWorkflow: () => { void removeSelected() },
  })

  const handleRetryRun = useCallback(async (runId: string) => {
    if (!selected) return
    setRetryInFlight(runId)
    try {
      await retryWorkflowRun(selected.id, runId)
      await refreshLatestRun(selected.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry run')
    } finally {
      setRetryInFlight(null)
    }
  }, [selected, refreshLatestRun])

  const handleFilterDryRun = useCallback(async () => {
    if (!selected) return
    // selectedGraphNode is derived later in the render flow; recompute it
    // here from the closure to avoid forward-reference issues at hook
    // declaration time.
    const node = graphNodes.find((n) => n.nodeId === selectedNodeId)
    if (!node || node.kind !== 'filter') return
    const expression = compileFilterExpression(filterConditions, filterMode)
    if (!expression.trim()) {
      setFilterDryRun({ matched: true, reason: 'Empty filter matches every row' })
      return
    }
    const sample = filterDryRunSample(schemaByTableId[selected.trigger.tableId])
    setFilterDryRunLoading(true)
    try {
      const result = await dryRunFilter(selected.id, expression, sample, selected.trigger.nodeId || 'trigger_1')
      if (!result.ok) {
        setFilterDryRun({ matched: false, reason: result.parseError || result.evalError || 'Expression failed to evaluate' })
      } else {
        setFilterDryRun({ matched: Boolean(result.matched) })
      }
    } catch (err) {
      setFilterDryRun({ matched: false, reason: err instanceof Error ? err.message : 'Dry-run failed' })
    } finally {
      setFilterDryRunLoading(false)
    }
    // filterConditions / filterMode are recomputed downstream of this
    // callback; we close over them via closure since the user button click
    // fires after render has stabilised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedNodeId, graphNodes, schemaByTableId])

  function openRunHistoryFor(workflow: WorkflowDefinition, run: WorkflowRunRecord | null) {
    guardSwitchTo(() => {
      setSelectedId(workflow.id)
      setActiveTab('history')
      setExpandedRunId(run?.id || null)
    })
  }

  const selectedSchema = selected ? schemaByTableId[selected.trigger.tableId] || fallbackSchemaFromWorkflow(selected, draft.body) : null
  const selectedTriggerLabel = selected ? triggerLabel(selected, tableLabels, t) : ''
  // Keep the scoped kitable label consistent with the file tree. The
  // selected workflow name already appears in the workflow tree, so the
  // detail topbar deliberately avoids repeating it.
  const scopedKitableLabel = scopedKitablePath
    ? scopedKitablePath.split('/').pop() || ''
    : ''
  const breadcrumbLeft = scopedKitableLabel || t('panels.home.workspaceFallback')
  const breadcrumbRight = t('panels.home.breadcrumb')
  // selectedTableLabel drives the "Run this action against a sample <X>"
  // copy in the test panel, which wants the actual bound table.
  const selectedTableLabel = selected
    ? tableLabels[selected.trigger.tableId]?.tableName
      || scopedKitableLabel
      || t('panels.home.tableLabelUnbound', { defaultValue: 'Not bound' })
    : t('panels.home.tableLabelWorkspace', { defaultValue: 'Workspace' })
  const selectedAddRecordTargetLabel = draft.addRecord?.targetTableId
    ? tableLabels[draft.addRecord.targetTableId]?.tableName
      || t('panels.addRecord.testTargetFallback')
    : t('panels.addRecord.testTargetFallback')
  const selectedLatestRun = selected ? latestRuns[selected.id] || null : null
  // Sorted, deduped list of (tableId, tableName, documentTitle) tuples for
  // the trigger's "Select table" dropdown. Built once per `tableLabels`
  // change so re-renders during typing don't re-sort. We expose the empty
  // option ("Not bound — draft") as the first item so the user can revert
  // to a draft workflow without leaving the drawer.
  //
  // When `scopedKitablePath` is set (workflow created inside a .kitable
  // tab), the picker is constrained to tables of that document — picking
  // a table from a sibling kitable would silently move the workflow out
  // of the user's current scope. The currently-bound tableId is always
  // kept in the list so a pre-existing out-of-scope binding still renders
  // as the selected option instead of falling back to the empty draft.
  const triggerTableOptions = useMemo(
    () => buildTriggerTableOptions(tableLabels, scopedKitablePath, selected?.trigger.tableId || ''),
    [tableLabels, scopedKitablePath, selected?.trigger.tableId],
  )

  const selectedGraphNode = useMemo(
    () => graphNodes.find((n) => n.nodeId === selectedNodeId) || null,
    [graphNodes, selectedNodeId],
  )
  const selectedNodeKind: 'trigger' | 'filter' | 'action' = selectedGraphNode?.kind
    || (selected && selectedNodeId === (selected.trigger.nodeId || 'trigger_1') ? 'trigger' : 'action')
  const filterConfigParsed = useMemo(() => {
    if (!selectedGraphNode || selectedGraphNode.kind !== 'filter') return null
    const expression = String((selectedGraphNode.config as { expression?: string })?.expression || '')
    const mode = ((selectedGraphNode.config as { mode?: 'all' | 'any' })?.mode) || 'all'
    const parsed = parseFilterExpression(expression)
    return parsed ? { conditions: parsed.conditions, mode: parsed.mode || mode } : { conditions: [], mode }
  }, [selectedGraphNode])
  const filterConditions: FilterCondition[] = filterConfigParsed?.conditions || []
  const filterMode: 'all' | 'any' = filterConfigParsed?.mode || 'all'
  const availableFilterFields = useMemo(() => {
    const triggerNodeId = selected?.trigger.nodeId || 'trigger_1'
    return (selectedSchema?.fields || []).map((f) => `${triggerNodeId}.${f.name}`)
  }, [selectedSchema, selected])

  // Run history view derived from visibleRuns + the status chip filter.
  const filteredVisibleRuns = useMemo(() => {
    if (runStatusFilter === 'all') return visibleRuns
    return visibleRuns.filter((r) => r.status === runStatusFilter)
  }, [visibleRuns, runStatusFilter])
  const runCounts = useMemo(() => countRunsByStatus(visibleRuns), [visibleRuns])

  const actionPanelContext: WorkflowActionPanelContext | null = selected ? {
    selected,
    draft,
    setDraft,
    validation,
    serverErrors: serverValidation.errors,
    saving: savingDraft,
    dirty: isDirty,
    hasValidationErrors,
    schema: selectedSchema,
    schemaByTableId,
    tableOptions: triggerTableOptions,
    nodeTest,
  } : null

  function openNodeInDrawer(nodeId: string) {
    setSelectedNodeId(nodeId)
    setDrawerOpen(true)
  }

  return (
    <div data-testid="workflow-home-page" className="flex h-full min-h-0 bg-card text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <WorkflowDetailTopbar
            selected={selected}
            hideClose={hideClose}
            scopedKitablePath={scopedKitablePath}
            streamLocked={streamLocked}
            onClose={handleClose}
            toggle={{ saving: togglingEnabled, onToggle: (next) => void toggleSelected(next) }}
            runTest={{
              visible: draft.actionType === 'send_email',
              running: runTest.status === 'running',
              blocked: Boolean(validation.to),
              onRun: () => void runSelectedTest(),
              onRunWithRow: (values) => void runSelectedTestWithRow(values),
            }}
            save={{ disabled: !isDirty || hasValidationErrors || savingDraft || streamLocked, saving: savingDraft, onSave: () => void saveSelected() }}
            actions={{ activeView: activeTab, deleting, onSelectView: setActiveTab, onDelete: requestDelete }}
          />
        ) : (
          <WorkflowIndexTopbar
            hideClose={hideClose}
            breadcrumbLeft={breadcrumbLeft}
            breadcrumbRight={breadcrumbRight}
            stats={{
              total: scopedKitablePath ? scopedWorkflows.length : workflows.length,
              active: scopedKitablePath ? scopedActiveCount : activeCount,
            }}
            onClose={handleClose}
            onRefresh={handleRefresh}
            onCreate={modeDialog.openDialog}
          />
        )}

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex flex-1 flex-col overflow-y-auto bg-background">
            {selected && actionPanelContext ? (
              <div className="relative flex min-h-full flex-1 flex-col pb-24">
                <WorkflowRunTestHeader lastRunFailed={selectedLatestRun?.status === 'error'} nameError={validation.name} runTest={runTest} />

                <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
                  {error ? <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
                  <WorkflowUnresolvedTemplateBanner fieldNames={unresolvedTemplate.fieldNames} onDismiss={unresolvedTemplate.dismiss} />
                  {activeTab === 'configuration' ? (
                    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="workflow-home-configuration-tab">
                      <WorkflowBuildBanner
                        streamLocked={streamLocked}
                        phase={streamingPreview?.phase}
                        buildError={streamingPreview?.error}
                        status={{
                          selected,
                          draft,
                          validation,
                          latestRun: selectedLatestRun,
                          onFix: () => openNodeInDrawer(selected.action.nodeId || 'action_1'),
                          onEnable: () => void toggleSelected(true),
                        }}
                      />

                      <div className="flex min-h-[480px] flex-1 gap-4">
                        <WorkflowCanvas onInsertAt={handleInsertAt} onRequestDeleteSelected={handleDeleteSelectedNode}>
                          <WorkflowCanvasNodes
                            graphNodes={graphNodes}
                            selected={selected}
                            draft={draft}
                            validation={validation}
                            issuesByNode={serverValidation.byNode}
                            latestRun={selectedLatestRun}
                            streamingPhase={streamLocked ? streamingPreview!.phase : null}
                            selectedNodeId={selectedNodeId}
                            connections={connections}
                            tableLabels={tableLabels}
                            triggerLabel={selectedTriggerLabel}
                            schema={selectedSchema}
                            onSelectNode={openNodeInDrawer}
                            onDuplicateNode={handleDuplicateNode}
                            onDeleteNode={handleDeleteNode}
                            onToggleDisabledNode={handleToggleDisabledNode}
                          />
                        </WorkflowCanvas>

                        <PropertiesDrawer
                          open={drawerOpen}
                          kind={selectedNodeKind === 'trigger' ? 'Trigger' : selectedNodeKind === 'filter' ? 'Filter' : 'Action'}
                          title={
                            selectedNodeKind === 'trigger'
                              ? t(triggerTitleI18nKey(selected.trigger.type))
                              : selectedNodeKind === 'filter'
                                ? filterNodeTitle(selectedGraphNode!)
                                : t(actionTitleI18nKey(draft.actionType))
                          }
                          footer={isDirty ? (
                            <WorkflowDrawerSaveRow
                              validationErrorCount={hasValidationErrors ? Object.keys(validation).length + serverValidation.errors.length : 0}
                              saving={savingDraft}
                              onDiscard={discardChanges}
                              onSave={() => void saveSelected()}
                            />
                          ) : null}
                          onClose={() => setDrawerOpen(false)}
                        >
                          {selectedNodeKind === 'trigger' ? (
                            <WorkflowTriggerDrawerPanel
                              selected={selected}
                              saving={savingDraft}
                              serverErrors={serverValidation.errors}
                              tableOptions={triggerTableOptions}
                              schema={selectedSchema}
                              editor={triggerEditor}
                            />
                          ) : selectedNodeKind === 'filter' && selectedGraphNode ? (
                            <FilterPropertiesPanel
                              conditions={filterConditions}
                              mode={filterMode}
                              availableFields={availableFilterFields}
                              expressionPreview={compileFilterExpression(filterConditions, filterMode)}
                              onChange={({ conditions, mode }) => {
                                setFilterDryRun(null)
                                setGraphNodes((current) => current.map((n) => (
                                  n.nodeId !== selectedGraphNode.nodeId
                                    ? n
                                    : { ...n, config: { ...n.config, mode, expression: compileFilterExpression(conditions, mode) } }
                                )))
                              }}
                              onDryRun={handleFilterDryRun}
                              dryRun={filterDryRun}
                              dryRunLoading={filterDryRunLoading}
                            />
                          ) : draft.actionType === 'add_record' ? (
                            <WorkflowAddRecordDrawerPanel context={actionPanelContext} targetLabel={selectedAddRecordTargetLabel} />
                          ) : ['update_record', 'lookup_record', 'transform_record'].includes(draft.actionType) ? (
                            <WorkflowRecordActionDrawerPanel context={actionPanelContext} />
                          ) : (
                            <WorkflowEmailDrawerPanel
                              context={actionPanelContext}
                              connections={connections}
                              onNewConnection={connectionsModal.openCreate}
                              onEditConnection={connectionsModal.openEdit}
                              sendTest={sendTest}
                              onSendInlineTest={() => void sendInlineTest()}
                              tableLabel={selectedTableLabel}
                            />
                          )}
                        </PropertiesDrawer>
                      </div>
                    </div>
                  ) : null}

                  {activeTab === 'history' ? (
                    <InlineRunHistory
                      status={selectedRuns.status}
                      runs={filteredVisibleRuns}
                      counts={runCounts}
                      statusFilter={runStatusFilter}
                      onStatusFilter={setRunStatusFilter}
                      onRetry={handleRetryRun}
                      retryInFlight={retryInFlight}
                      error={selectedRuns.error}
                      expandedRunId={expandedRunId}
                      onToggle={(id) => setExpandedRunId((current) => current === id ? null : id)}
                      onJumpToNode={(nodeId) => {
                        // Same landing spot as the status banner's Fix action.
                        openNodeInDrawer(nodeId)
                        setActiveTab('configuration')
                      }}
                    />
                  ) : null}

                  {activeTab === 'logs' ? (
                    <LogsView status={selectedRuns.status} runs={visibleRuns} error={selectedRuns.error} />
                  ) : null}
                </div>

                <WorkflowSaveBar
                  dirty={isDirty}
                  dirtyFields={dirtyFields}
                  drawerOpen={drawerOpen}
                  saving={savingDraft}
                  saveDisabled={hasValidationErrors || savingDraft}
                  onDiscard={discardChanges}
                  onSave={() => void saveSelected()}
                />
              </div>
            ) : status === 'done' ? (
              <WorkflowEmptyState
                scopedKitablePath={scopedKitablePath}
                scopedKitableLabel={scopedKitableLabel}
                scopedWorkflows={scopedWorkflows}
                latestRuns={latestRuns}
                tableLabels={tableLabels}
                launcher={launcher}
                onOpenModeDialog={modeDialog.openDialog}
                onSelect={handleSelectListItem}
              />
            ) : null}
          </main>
        </div>
      </div>

      <WorkspaceWorkflowCreateModeDialog
        open={modeDialog.open}
        context={modeDialog.context}
        onOpenChange={(open) => {
          if (!open) modeDialog.closeDialog()
        }}
        onSelect={(choice) => modeDialog.handleSelect(choice, {
          runTemplate: launcher.runTemplate,
          runScratch: launcher.runScratch,
        })}
        busyKind={modeDialog.busyKind}
        busyTemplateId={modeDialog.busyTemplateId}
        errorMessage={modeDialog.error}
      />
      {connectionsModal.isOpen ? (
        <ConnectionModal
          channel={channels.find((item) => item.channel === 'email_smtp')}
          initial={connectionsModal.editingId
            ? (() => {
                const existing = connections.find((c) => c.id === connectionsModal.editingId)
                return existing ? formFromConnection(existing) : undefined
              })()
            : undefined}
          onClose={connectionsModal.close}
          onSaved={async (connection) => {
            await refreshConnections()
            setDraft((current) => ({ ...current, connectionId: connection.id }))
            connectionsModal.close()
          }}
        />
      ) : null}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
