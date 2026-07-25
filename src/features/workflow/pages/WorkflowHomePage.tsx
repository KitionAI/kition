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
import { listChannels, listConnections, type ChannelSchema, type ConnectionView } from '@/features/connections/api'
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  patchWorkflow,
  type WorkflowAddRecordConfig,
  type WorkflowDefinition,
} from '@/features/workflow/api'
import { WORKFLOW_ENABLED_CHANGED_EVENT } from '@/features/workflow/lib/workflowEvents'
import {
  actionInlineError,
  actionNodeDescription,
  actionStatus,
  actionTitleI18nKey,
  cloneAddRecord,
  cloneBody,
  draftToValidationPatch,
  emptyDraft,
  fallbackSchemaFromWorkflow,
  filterNodeDescription,
  filterNodeStatus,
  filterNodeTitle,
  findDanglingFieldRefs,
  parseIdAsNumber,
  pruneBody,
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
import type { InsertableActionType } from '@/features/workflow/canvas/WorkflowNodePicker'
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
import { filtersForPatch, normaliseGraph, type GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import { useWorkflowValidation } from '@/features/workflow/hooks/useWorkflowValidation'
import { dryRunFilter, retryWorkflowRun } from '@/features/workflow/api'

const inputClassName = 'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:bg-muted/40 disabled:text-muted-foreground'

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
      const filterNodes = filtersForPatch({ nodes: graphNodes, edges: [] })
      const triggerNodeId = selected.trigger.nodeId || 'trigger_1'
      const actionNodeId = selected.action.nodeId || 'action_1'
      // For add_record we resolve the target's documentId from the
      // tableLabels cache so the server can route the write to the right
      // datadoc (the panel only emits targetTableId — see
      // AddRecordActionPropertiesPanel's handleTargetTableChange comment).
      const addRecordPayload: WorkflowAddRecordConfig | undefined =
        draft.actionType === 'add_record' && draft.addRecord
          ? {
              targetTableId: draft.addRecord.targetTableId,
              targetDocumentId: draft.addRecord.targetDocumentId
                || tableLabels[draft.addRecord.targetTableId]?.documentId
                || undefined,
              fields: (draft.addRecord.fields || []).map((entry) => ({
                fieldId: entry.fieldId,
                value: cloneBody(entry.value),
              })),
            }
          : undefined
      const actionConfig = draft.actionType === 'add_record'
        ? {
            nodeId: actionNodeId,
            type: 'add_record',
            addRecord: addRecordPayload,
          }
        : draft.actionType === 'update_record'
          ? { nodeId: actionNodeId, type: 'update_record', updateRecord: draft.updateRecord }
          : draft.actionType === 'lookup_record'
            ? { nodeId: actionNodeId, type: 'lookup_record', lookupRecord: draft.lookupRecord }
            : draft.actionType === 'transform_record'
              ? { nodeId: actionNodeId, type: 'transform_record', transformRecord: draft.transformRecord }
        : {
            nodeId: actionNodeId,
            type: selected.action.type || 'send_email',
            connectionId: draft.connectionId,
            to: draft.to.trim(),
            subject: draft.subject,
            body: cloneBody(draft.body),
          }
      const fullNodes = [
        {
          nodeId: triggerNodeId,
          kind: 'trigger' as const,
          config: { nodeId: triggerNodeId, type: selected.trigger.type, tableId: selected.trigger.tableId, documentId: selected.trigger.documentId },
        },
        ...filterNodes,
        {
          nodeId: actionNodeId,
          kind: 'action' as const,
          config: actionConfig,
        },
      ]
      const fullEdges = []
      for (let i = 0; i < fullNodes.length - 1; i += 1) {
        fullEdges.push({ from: fullNodes[i].nodeId, to: fullNodes[i + 1].nodeId })
      }
      const actionPatch = draft.actionType === 'add_record'
        ? { type: 'add_record' as const, addRecord: addRecordPayload }
        : draft.actionType === 'update_record'
          ? { type: 'update_record' as const, updateRecord: draft.updateRecord }
          : draft.actionType === 'lookup_record'
            ? { type: 'lookup_record' as const, lookupRecord: draft.lookupRecord }
            : draft.actionType === 'transform_record'
              ? { type: 'transform_record' as const, transformRecord: draft.transformRecord }
        : {
            connectionId: draft.connectionId,
            to: draft.to.trim(),
            subject: draft.subject,
            body: cloneBody(draft.body),
          }
      const updated = await patchWorkflow(selected.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        action: actionPatch,
        nodes: fullNodes,
        edges: fullEdges,
      })
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

  /** Bind / rebind the trigger's table from the drawer dropdown. Commits
   *  immediately via PATCH instead of routing through the draft → Save
   *  flow because the table change has downstream effects (schema reload,
   *  body-template token validity) that the rest of the page already
   *  reacts to when `selected` updates. Passing an empty tableId is the
   *  contract for unbinding (returns the workflow to the draft state). */
  async function setTriggerTable(nextTableId: string) {
    if (!selected) return
    const label = nextTableId ? tableLabels[nextTableId] : null
    const nextDocumentId = label?.documentId || ''
    // No-op when the table is already what's selected — avoids a spurious
    // PATCH and the resulting toast / refresh churn.
    if (nextTableId === selected.trigger.tableId && nextDocumentId === selected.trigger.documentId) {
      return
    }
    // Before committing, inspect the action body for field_refs that won't
    // resolve under the new table's schema. Without this prompt the user
    // would see "missing field" warnings appear in the body editor with no
    // clear path forward — the underlying data is stale but the UI doesn't
    // suggest a fix. We fetch the schema on demand so the check is reliable
    // even on the first switch to a never-loaded table. add_record per-field
    // templates are not yet covered (each entry is its own BodyTemplate, and
    // pruning them in the same PATCH requires sending the full addRecord
    // shape — deferred to a follow-up).
    if (nextTableId && nextDocumentId && selected.action.type !== 'add_record') {
      const newSchema = await ensureSchemaLoaded(nextDocumentId, nextTableId)
      const danglingIds = newSchema
        ? findDanglingFieldRefs(selected.action.body, newSchema)
        : []
      if (danglingIds.length > 0) {
        await new Promise<void>((resolve) => {
          setConfirm({
            title: t('confirms.switchTriggerTable.title', { tableName: label?.tableName || t('confirms.switchTriggerTable.tableFallback') }),
            message: t('confirms.switchTriggerTable.message', { count: danglingIds.length }),
            confirmLabel: t('confirms.switchTriggerTable.confirm'),
            destructive: true,
            onConfirm: () => {
              void commitTriggerTableSwap({
                nextTableId,
                nextDocumentId,
                pruneFieldIds: danglingIds,
              }).then(resolve, resolve)
            },
          })
          // The Cancel branch closes the dialog without commit. We resolve
          // immediately so the calling `await` returns; the user's intent
          // ("don't switch tables") is the silent no-op.
          // setConfirm only triggers resolve once the dialog closes via
          // onConfirm above; tag the resolve through onClose by overriding
          // setConfirm wrapping if needed. For now, callers don't await
          // setTriggerTable beyond catching errors, so resolving via
          // onConfirm is sufficient.
        })
        return
      }
    }
    await commitTriggerTableSwap({ nextTableId, nextDocumentId, pruneFieldIds: [] })
  }

  async function ensureSchemaLoaded(documentId: string, tableId: string): Promise<TableSchema | null> {
    // Delegates to the cache hook: short-circuit on cache hit, dedupe
    // concurrent fetches, swallow errors to null. The page-level helper
    // stays as a name-level shim because it's referenced from multiple
    // handlers — switching every call site to schemaCache.ensure would
    // ripple further than this PR's scope.
    return schemaCache.ensure(documentId, tableId, tableLabels[tableId]?.tableName)
  }

  async function commitTriggerTableSwap({ nextTableId, nextDocumentId, pruneFieldIds }: {
    nextTableId: string
    nextDocumentId: string
    pruneFieldIds: string[]
  }) {
    if (!selected) return
    setSavingDraft(true)
    setError('')
    try {
      // Default to record_created when binding from an empty draft; preserve
      // the existing type otherwise so a user who had record_updated picked
      // doesn't silently flip back. Cast to the patch type — the runtime
      // type field is a wide `string` (back-compat for legacy triggers) but
      // the patch surface narrows it to the supported enum.
      const nextType = (selected.trigger.type || 'record_created') as 'record_created'
        | 'record_updated' | 'record_created_or_updated' | 'scheduled_time'
        | 'record_date_reached' | ''
      // Drop required-field IDs that the new table's schema doesn't know
      // about. The trigger gate can never fire on a field that doesn't
      // exist, so leaving them around just clutters the drawer with a
      // permanent "(removed)" warning. We resolve the new schema via the
      // cache — populated by the dangling-body-refs check in
      // setTriggerTable for non-add_record actions, and pulled on demand
      // here for add_record (which skipped the body check).
      const currentRequired = selected.trigger.requiredFields || []
      let nextRequired: string[] | undefined
      if (currentRequired.length > 0) {
        const newSchema = await ensureSchemaLoaded(nextDocumentId, nextTableId)
        if (newSchema) {
          const validIds = new Set(newSchema.fields.map((f) => f.id))
          const pruned = currentRequired.filter((id) => validIds.has(id))
          if (pruned.length !== currentRequired.length) {
            nextRequired = pruned
          }
        }
      }
      const triggerPatch: NonNullable<Parameters<typeof patchWorkflow>[1]['trigger']> = {
        ...selected.trigger,
        type: nextType,
        documentId: nextDocumentId,
        tableId: nextTableId,
      }
      if (nextRequired !== undefined) {
        triggerPatch.requiredFields = nextRequired
      }
      const updated = await patchWorkflow(selected.id, pruneFieldIds.length > 0
        ? {
            trigger: triggerPatch,
            // Strip the dangling field_refs from the body. We keep text and
            // newline parts intact and only drop field_refs whose fieldId is
            // on the prune list. Empty pruneFieldIds short-circuits before
            // this branch, so this only runs when the user opted in via the
            // ConfirmDialog above.
            action: { body: pruneBody(selected.action.body, pruneFieldIds) },
          }
        : { trigger: triggerPatch })
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update trigger table')
    } finally {
      setSavingDraft(false)
    }
  }

  async function sendInlineTest() {
    if (!selected || validation.to) return
    await sendTest.send(selected.id, draft.to)
    await refreshLatestRun(selected.id)
  }

  /** Patch the scheduled_time trigger's cron string in place. Mirrors
   *  setTriggerTable: commits immediately via PATCH rather than routing
   *  through the draft → Save loop, because the cron value has no
   *  downstream coupling to the email body fields (no schema reload).
   *  Empty cron is allowed — it leaves the trigger as a scheduled draft
   *  the backend's Validate() tolerates when Enabled=false. */
  async function setTriggerSchedule(next: { cron: string; timezone: string }) {
    if (!selected) return
    const trimmed = next.cron.trim()
    const tz = next.timezone.trim()
    const currentCron = (selected.trigger.schedule?.cron || '').trim()
    const currentTZ = (selected.trigger.schedule?.timezone || '').trim()
    if (trimmed === currentCron && tz === currentTZ) return
    setSavingDraft(true)
    setError('')
    try {
      const updated = await patchWorkflow(selected.id, {
        trigger: {
          // Preserve nodeId so the patch lands on the same trigger node
          // (the backend's TriggerPatch derives identity from nodeId).
          nodeId: selected.trigger.nodeId,
          type: 'scheduled_time',
          schedule: { cron: trimmed, timezone: tz },
        },
      })
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update schedule')
    } finally {
      setSavingDraft(false)
    }
  }

  /** Switch the trigger type from the drawer dropdown. Commits immediately
   *  (like setTriggerTable / setTriggerSchedule) because the type swap
   *  rearranges the rest of the trigger panel — scheduled_time hides the
   *  table picker and shows the cron editor; record-bearing types do the
   *  opposite. We normalise the surrounding fields per transition so the
   *  backend never sees a half-mode trigger (e.g. type=scheduled_time
   *  still carrying a tableId):
   *    - record → record: keep table/document/requiredFields untouched.
   *    - record → scheduled_time: clear table/document, drop required
   *      fields (they reference fields on the now-disowned table), and
   *      seed an empty schedule the user fills in via the cron picker.
   *    - scheduled_time → record: clear the schedule (no longer
   *      consulted) and leave table empty so the user explicitly picks
   *      one in the table dropdown below. */
  async function setTriggerType(
    nextType: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'scheduled_time' | 'record_date_reached',
  ) {
    if (!selected) return
    const currentType = selected.trigger.type || 'record_created'
    if (currentType === nextType) return
    setSavingDraft(true)
    setError('')
    try {
      const triggerPatch: NonNullable<Parameters<typeof patchWorkflow>[1]['trigger']> = {
        nodeId: selected.trigger.nodeId,
        type: nextType,
      }
      if (nextType === 'scheduled_time') {
        triggerPatch.documentId = ''
        triggerPatch.tableId = ''
        triggerPatch.requiredFields = []
        triggerPatch.schedule = {
          cron: selected.trigger.schedule?.cron || '',
          timezone: selected.trigger.schedule?.timezone || '',
        }
      } else if (currentType === 'scheduled_time') {
        // Coming back to a record-bearing type. Wipe the schedule so the
        // server doesn't keep dispatching the cron after the trigger
        // table is rebound.
        triggerPatch.documentId = selected.trigger.documentId || ''
        triggerPatch.tableId = selected.trigger.tableId || ''
        triggerPatch.schedule = { cron: '', timezone: '' }
      } else {
        // record → record: nothing else to migrate. We still echo the
        // table/document IDs so the patch round-trips deterministically
        // (an omitted key keeps its prior value, but the patch tests
        // assert on the wire shape).
        triggerPatch.documentId = selected.trigger.documentId || ''
        triggerPatch.tableId = selected.trigger.tableId || ''
        if (selected.trigger.requiredFields !== undefined) {
          triggerPatch.requiredFields = selected.trigger.requiredFields
        }
      }
      const updated = await patchWorkflow(selected.id, { trigger: triggerPatch })
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update trigger type')
    } finally {
      setSavingDraft(false)
    }
  }

  /** Patch the trigger's RequiredFields gate. Sends the next list as-is
   *  (the backend uses pointer semantics: `[]` clears, `[...]` replaces).
   *  No-ops when nothing changed so a stray checkbox-render doesn't
   *  generate a spurious PATCH + toast. */
  async function setTriggerRequiredFields(next: string[]) {
    if (!selected) return
    const current = selected.trigger.requiredFields || []
    if (current.length === next.length && current.every((id, i) => id === next[i])) return
    setSavingDraft(true)
    setError('')
    try {
      const updated = await patchWorkflow(selected.id, {
        trigger: {
          nodeId: selected.trigger.nodeId,
          requiredFields: next,
        },
      })
      setWorkflows((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update required fields')
    } finally {
      setSavingDraft(false)
    }
  }

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

  const handleDeleteNode = useCallback((nodeId: string) => {
    if (!selected) return
    const idx = graphNodes.findIndex((n) => n.nodeId === nodeId)
    if (idx < 0) return
    const node = graphNodes[idx]
    if (node.kind === 'trigger') {
      setConfirm({
        title: t('confirms.deleteTriggerWorkflow.title'),
        message: t('confirms.deleteTriggerWorkflow.message'),
        confirmLabel: t('confirms.deleteTriggerWorkflow.confirm'),
        destructive: true,
        onConfirm: () => { void removeSelected() },
      })
      return
    }
    if (node.kind === 'action') {
      // The single email action is the legacy primary action — deleting it
      // would leave the workflow without a delivery step. We block the
      // delete and surface a hint instead.
      setError(t('errors.primaryActionLocked'))
      return
    }
    setConfirm({
      title: t('confirms.deleteFilter.title'),
      message: t('confirms.deleteFilter.message'),
      confirmLabel: t('confirms.deleteFilter.confirm'),
      destructive: true,
      onConfirm: () => {
        const next = graphNodes.filter((_, i) => i !== idx)
        setGraphNodes(next)
        // If the deleted node was selected, fall back to the action.
        if (selectedNodeId === nodeId) {
          setSelectedNodeId(selected.action.nodeId || 'action_1')
        }
      },
    })
  }, [graphNodes, selected, selectedNodeId])

  const handleDuplicateNode = useCallback((nodeId: string) => {
    if (!selected) return
    const idx = graphNodes.findIndex((n) => n.nodeId === nodeId)
    if (idx < 0) return
    const original = graphNodes[idx]
    // Trigger / action are singletons in v1 — only filters can be cloned.
    if (original.kind !== 'filter') {
      setError(`${original.kind} nodes can't be duplicated in this release.`)
      return
    }
    const clone: GraphNode = {
      ...original,
      nodeId: `filter_${Date.now().toString(36)}`,
      config: { ...original.config, nodeId: `filter_${Date.now().toString(36)}` },
    }
    const next = [...graphNodes]
    next.splice(idx + 1, 0, clone)
    setGraphNodes(next)
  }, [graphNodes, selected])

  const handleToggleDisabledNode = useCallback((nodeId: string, disabled: boolean) => {
    setGraphNodes((current) => current.map((n) => n.nodeId === nodeId ? { ...n, disabled } : n))
  }, [])

  const handleInsertAt = useCallback((index: number, kind: 'filter' | 'action', actionType?: InsertableActionType) => {
    if (kind === 'action' && actionType) {
      setDraft((current) => ({
        ...current,
        actionType,
        connectionId: actionType === 'send_email' ? current.connectionId : '',
        to: actionType === 'send_email' ? current.to : '',
        subject: actionType === 'send_email' ? current.subject : { parts: [] },
        body: actionType === 'send_email' ? current.body : { parts: [] },
        addRecord: actionType === 'add_record' ? current.addRecord || { targetTableId: '', fields: [] } : undefined,
        updateRecord: actionType === 'update_record' ? current.updateRecord || { target: 'trigger_record', fields: [] } : undefined,
        lookupRecord: actionType === 'lookup_record' ? current.lookupRecord || { targetTableId: '', matchFieldId: '', matchValue: { parts: [] }, writeBack: [] } : undefined,
        transformRecord: actionType === 'transform_record' ? current.transformRecord || { operations: [] } : undefined,
      }))
      setSelectedNodeId(selected?.action.nodeId || 'action_1')
      setDrawerOpen(true)
      return
    }
    if (kind !== 'filter') return
    // Insert a fresh filter node between graphNodes[index-1] and graphNodes[index].
    // The trigger always sits at position 0 and the primary action sits at
    // position graphNodes.length-1; filters can go anywhere between.
    const newId = `filter_${Date.now().toString(36)}`
    const newNode: GraphNode = {
      nodeId: newId,
      kind: 'filter',
      config: {
        nodeId: newId,
        type: 'filter',
        expression: '',
        mode: 'all',
      },
    }
    const next = [...graphNodes]
    next.splice(index, 0, newNode)
    setGraphNodes(next)
    setSelectedNodeId(newId)
    setDrawerOpen(true)
  }, [graphNodes, selected])

  const handleDeleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return
    handleDeleteNode(selectedNodeId)
  }, [selectedNodeId, handleDeleteNode])

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
    const sample: Record<string, unknown> = {}
    const tableId = selected.trigger.tableId
    const schema = schemaByTableId[tableId]
    if (schema) {
      for (const field of schema.fields) {
        sample[field.name] = field.type === 'number' ? 0 : ''
      }
    }
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
  const triggerTableOptions = useMemo(() => {
    const currentTableId = selected?.trigger.tableId || ''
    return Object.entries(tableLabels)
      .filter(([tableId, label]) => {
        if (!scopedKitablePath) return true
        if (tableId === currentTableId) return true
        return label.documentPath === scopedKitablePath
      })
      .map(([tableId, label]) => ({
        tableId,
        tableName: label.tableName,
        documentTitle: label.documentTitle,
      }))
      .sort((a, b) => {
        const docCmp = a.documentTitle.localeCompare(b.documentTitle)
        if (docCmp !== 0) return docCmp
        return a.tableName.localeCompare(b.tableName)
      })
  }, [tableLabels, scopedKitablePath, selected?.trigger.tableId])

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
  const runCounts = useMemo(() => ({
    all: visibleRuns.length,
    ok: visibleRuns.filter((r) => r.status === 'ok').length,
    error: visibleRuns.filter((r) => r.status === 'error').length,
    skipped: visibleRuns.filter((r) => r.status === 'skipped').length,
  }), [visibleRuns])

  return (
    <div data-testid="workflow-home-page" className="flex h-full min-h-0 bg-card text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          // Consolidated topbar: back arrow + ON/OFF + run-test + save + more.
          // Secondary views and destructive actions live in the More menu.
          // The surrounding workspace already identifies the active
          // kitable and workflow, so this bar avoids repeating either name.
          // Replaces the old [breadcrumb row + stats row + detail-header
          // row] stack so the detail page reads as a single focused surface.
          // The stats badge has no meaning when we're already showing a
          // single workflow — it lived on the index page anyway, and
          // WorkflowIndexPage now owns that role.
          <div
            className={`flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 text-sm ${scopedKitablePath ? 'h-14' : 'h-12'}`}
            data-testid="workflow-home-topbar"
          >
            {hideClose ? null : (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted"
                onClick={handleClose}
                aria-label={t('panels.home.closeAria')}
                data-testid="workflow-home-back"
              >
                <ChevronLeft className="size-4" />
                <span className="truncate max-w-[160px]">{t('panels.home.h1')}</span>
              </button>
            )}
            <WorkflowStatusToggle enabled={selected.enabled} saving={togglingEnabled} onToggle={(next) => void toggleSelected(next)} disabled={streamLocked} />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {draft.actionType !== 'send_email' ? null : (
                <>
                  <Button variant="outline" onClick={() => void runSelectedTest()} disabled={streamLocked || runTest.status === 'running' || Boolean(validation.to)} data-testid="workflow-home-run-test">
                    {runTest.status === 'running' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                    {t('panels.home.runTest')}
                  </Button>
                  {selected.trigger.type === 'record_created'
                    || selected.trigger.type === 'record_updated'
                    || selected.trigger.type === 'record_created_or_updated' ? (
                    <SampleRowPicker
                      documentId={parseIdAsNumber(selected.trigger.documentId)}
                      tableId={parseIdAsNumber(selected.trigger.tableId)}
                      disabled={streamLocked || runTest.status === 'running' || Boolean(validation.to)}
                      onPick={(values) => { void runSelectedTestWithRow(values) }}
                    />
                  ) : null}
                </>
              )}
              <Button
                onClick={() => void saveSelected()}
                disabled={!isDirty || hasValidationErrors || savingDraft || streamLocked}
                data-testid="workflow-home-save-topbar"
              >
                {savingDraft ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t('panels.home.save')}
              </Button>
              <WorkflowHomeActionsMenu
                activeView={activeTab}
                labels={{
                  moreActions: t('panels.home.moreActions'),
                  configuration: t('panels.home.tabConfiguration'),
                  history: t('panels.home.tabRunHistory'),
                  logs: t('panels.home.tabLogs'),
                  delete: t('panels.home.delete'),
                }}
                deleting={deleting}
                deleteDisabled={streamLocked || deleting}
                onSelectView={setActiveTab}
                onDelete={requestDelete}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-5 text-sm">
              <span className="truncate text-muted-foreground">{breadcrumbLeft}</span>
              <span className="text-muted-foreground/60">/</span>
              <span className="truncate font-medium">{breadcrumbRight}</span>
              {hideClose ? null : (
                <button type="button" className="ml-auto inline-grid size-8 place-items-center rounded-lg hover:bg-muted" onClick={handleClose} aria-label={t('panels.home.closeAria')}>
                  <X className="size-4" />
                </button>
              )}
            </div>

            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold">{t('panels.home.h1')}</h1>
                <span className="rounded-lg bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t('panels.home.stats', { total: scopedKitablePath ? scopedWorkflows.length : workflows.length, active: scopedKitablePath ? scopedActiveCount : activeCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="inline-grid size-8 place-items-center rounded-lg border border-border bg-card hover:bg-muted/40" onClick={handleRefresh} aria-label={t('panels.home.refreshAria')}>
                  <RefreshCw className="size-4" />
                </button>
                <Button className="h-8 bg-primary px-3 hover:bg-primary/90" onClick={modeDialog.openDialog} data-testid="workflow-home-create">
                  <Plus className="size-4" />
                  {t('panels.home.create')}
                </Button>
              </div>
            </div>
          </>
        )}

        <div className="flex min-h-0 flex-1">

          <main className="min-w-0 flex flex-1 flex-col overflow-y-auto bg-background">
            {selected ? (
              <div className="relative flex min-h-full flex-1 flex-col pb-24">
                {selectedLatestRun?.status === 'error' || validation.name || runTest.status === 'done' || runTest.status === 'error' ? (
                  <header className="border-b border-border bg-card px-6 py-3">
                    {selectedLatestRun?.status === 'error' ? (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle className="size-3.5" />
                        {t('panels.home.failingLastRun')}
                      </span>
                    ) : null}
                    {validation.name ? <div className="mt-1 text-[11px] text-destructive" data-testid="workflow-home-field-error">{t(`panels.home.validation.${validation.name}`)}</div> : null}
                    {runTest.status === 'done' && runTest.result ? (
                      <div data-testid="workflow-home-run-test-status" className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success-foreground">
                        <div className="font-semibold">{t('panels.home.testEmailDelivered')}</div>
                        <div className="mt-2 grid gap-1 text-success-foreground" data-testid="workflow-home-run-test-preview">
                          <div><strong>{t('panels.home.detailTo')}</strong>&nbsp;&nbsp;{runTest.result.input.to}</div>
                          <div><strong>{t('panels.home.detailSubject')}</strong>&nbsp;&nbsp;{runTest.result.input.subject}</div>
                          <div data-testid="workflow-home-run-test-body" className="whitespace-pre-wrap"><strong>{t('panels.home.detailBody')}</strong>&nbsp;&nbsp;{runTest.result.input.body}</div>
                        </div>
                      </div>
                    ) : null}
                    {runTest.status === 'error' ? (
                      <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="workflow-home-run-test-error">{runTest.error}</div>
                    ) : null}
                  </header>
                ) : null}

                <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
                  {error ? <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
                  {unresolvedTemplate.fieldNames.length > 0 ? (
                    <div
                      data-testid="workflow-home-template-unresolved-banner"
                      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
                      role="status"
                    >
                      <div className="flex-1 leading-snug">
                        <strong className="font-semibold">
                          {t('panels.home.unresolvedTitle', { count: unresolvedTemplate.fieldNames.length })}
                        </strong>
                        <span className="ml-1">
                          {t('panels.home.unresolvedBody', { names: unresolvedTemplate.fieldNames.join(', ') })}
                        </span>
                      </div>
                      <button
                        type="button"
                        data-testid="workflow-home-template-unresolved-dismiss"
                        onClick={unresolvedTemplate.dismiss}
                        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-warning-foreground hover:bg-warning/20"
                      >
                        {t('panels.home.unresolvedDismiss')}
                      </button>
                    </div>
                  ) : null}
                  {activeTab === 'configuration' ? (
                    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="workflow-home-configuration-tab">
                      {streamLocked ? (
                        <div
                          data-testid="workflow-home-streaming-banner"
                          className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary"
                          role="status"
                        >
                          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                          <span className="font-medium">{t('panels.home.streamingBanner.title')}</span>
                          <span className="text-primary">·</span>
                          <span className="text-xs text-primary">{t(phaseLabelKey(streamingPreview!.phase))}</span>
                        </div>
                      ) : streamingPreview?.error ? (
                        <div
                          data-testid="workflow-home-streaming-error"
                          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                          role="alert"
                        >
                          <strong>{t('panels.home.streamingBanner.errorTitle')}</strong> {streamingPreview.error}
                        </div>
                      ) : (
                        <StatusBannerSlot
                          selected={selected}
                          draft={draft}
                          validation={validation}
                          latestRun={selectedLatestRun}
                          onFix={() => {
                            setSelectedNodeId(selected.action.nodeId || 'action_1')
                            setDrawerOpen(true)
                          }}
                          onEnable={() => void toggleSelected(true)}
                        />
                      )}

                      <div className="flex min-h-[480px] flex-1 gap-4">
                        <WorkflowCanvas
                          onInsertAt={handleInsertAt}
                          onRequestDeleteSelected={handleDeleteSelectedNode}
                        >
                          {graphNodes.map((node, index) => {
                            const isTrigger = node.kind === 'trigger'
                            const isFilter = node.kind === 'filter'
                            const isActionNode = node.kind === 'action'
                            const nodeIssues = serverValidation.byNode[node.nodeId] || []
                            const hasNodeError = nodeIssues.some((i) => (i.level ?? 'error') === 'error')
                            const hasNodeWarn = nodeIssues.some((i) => i.level === 'warning')
                            const baseStatus = isTrigger
                              ? triggerStatus(selected, validation)
                              : isFilter
                                ? filterNodeStatus(node)
                                : actionStatus(draft, validation, selectedLatestRun)
                            // During streaming the synthetic preview's nodes light up
                            // in lockstep with the SSE phase so the canvas reads
                            // visibly "in flight" — trigger goes green once
                            // trigger.generated lands, action goes amber while
                            // action.generated is being drained, green once persisted.
                            const phaseStatus: NodeStatus | null = streamLocked && !isFilter
                              ? statusForPhase(streamingPreview!.phase, isTrigger ? 'trigger' : 'action')
                              : null
                            // Promote based on server-side issues.
                            const status: NodeStatus = phaseStatus
                              ?? (hasNodeError
                                ? 'red'
                                : hasNodeWarn && baseStatus !== 'red'
                                  ? 'amber'
                                  : baseStatus)
                            return (
                              <NodeCard
                                key={node.nodeId}
                                kind={node.kind}
                                rowLabel={
                                  isTrigger
                                    ? t('panels.home.nodeCard.triggerLabel')
                                    : isFilter
                                      ? t('panels.home.nodeCard.stepFilter', { index: index + 1 })
                                    : draft.actionType === 'add_record'
                                      ? t('panels.home.nodeCard.stepActionAddRecord', { index: index + 1 })
                                      : t('panels.home.nodeCard.stepActionGeneric', { index: index + 1 })
                                }
                                title={
                                  isTrigger
                                    ? t(triggerTitleI18nKey(selected.trigger.type))
                                    : isFilter
                                      ? filterNodeTitle(node)
                                      : t(actionTitleI18nKey(draft.actionType))
                                }
                                description={
                                  isTrigger
                                    ? selectedTriggerLabel
                                    : isFilter
                                      ? filterNodeDescription(node)
                                      : actionNodeDescription(draft, connections, tableLabels, t)
                                }
                                status={status}
                                disabled={node.disabled}
                                selected={selectedNodeId === node.nodeId}
                                onSelect={() => {
                                  setSelectedNodeId(node.nodeId)
                                  setDrawerOpen(true)
                                }}
                                onAskAI={
                                  isFilter
                                    ? undefined
                                    : () => publishWorkflowNodeAskAI({
                                        workflow: { id: selected.id, name: selected.name },
                                        nodeId: node.nodeId,
                                        nodeKind: isTrigger ? 'trigger' : 'action',
                                        nodeConfig: node.config,
                                        tableSchema: selectedSchema,
                                      })
                                }
                                onDuplicate={isFilter ? () => handleDuplicateNode(node.nodeId) : undefined}
                                onDelete={isTrigger ? undefined : () => handleDeleteNode(node.nodeId)}
                                onToggleDisabled={isFilter ? (next) => handleToggleDisabledNode(node.nodeId, next) : undefined}
                                inlineError={
                                  isActionNode
                                    ? (() => {
                                        const serverError = nodeIssues.find((i) => (i.level ?? 'error') === 'error')
                                        const serverWarning = nodeIssues.find((i) => i.level === 'warning')
                                        const existing = actionInlineError({ draft, validation, latestRun: selectedLatestRun, t })
                                        const localError = existing
                                          ? {
                                              ...existing,
                                              fixLabel: 'Fix',
                                              severity: (selectedLatestRun?.status === 'error' || selected.enabled ? 'error' : 'warning') as 'error' | 'warning',
                                              onFix: () => {
                                                setSelectedNodeId(node.nodeId)
                                                setDrawerOpen(true)
                                              },
                                            }
                                          : null
                                        // Server errors take precedence; otherwise fall back to the
                                        // existing local-side derivation. Warnings show as muted text
                                        // and don't surface a Fix button.
                                        // Severity:
                                        //   * runtime failure (latestRun status === 'error') stays red,
                                        //     server-emitted error stays red — these are real blockers,
                                        //   * draft-state validation issues (the user is still composing
                                        //     and the workflow is OFF) downgrade to amber so the canvas
                                        //     doesn't look like a P0 page when it's just "fill the To
                                        //     field". `enabled` workflows treat the same validation as
                                        //     red because the next run will fail.
                                        // A missing reusable connection is the exception: the server may
                                        // report the legacy fallback as "smtp host not configured", but
                                        // the actionable problem in this UI is that no connection is bound.
                                        if (draft.actionType === 'send_email' && !draft.connectionId && localError) {
                                          return localError
                                        }
                                        if (serverError) {
                                          return {
                                            message: serverError.message,
                                            fixLabel: 'Fix',
                                            severity: 'error' as const,
                                            onFix: () => {
                                              setSelectedNodeId(node.nodeId)
                                              setDrawerOpen(true)
                                            },
                                          }
                                        }
                                        if (localError) return localError
                                        if (serverWarning) {
                                          // Warnings render as advisory only — no Fix button, no
                                          // status escalation past amber, Save still allowed.
                                          return { message: serverWarning.message, severity: 'warning' as const }
                                        }
                                        return null
                                      })()
                                    : null
                                }
                                dataRole={node.kind}
                              />
                            )
                          })}
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
                            <div className="flex items-center gap-2" data-testid="workflow-drawer-save-row">
                              <span className="size-2 shrink-0 rounded-full bg-warning" />
                              <span className="flex-1 truncate text-[12px] text-muted-foreground">
                                {hasValidationErrors
                                  ? t('panels.drawer.saveBar.validationErrors', { count: Object.keys(validation).length + serverValidation.errors.length })
                                  : t('panels.drawer.saveBar.unsavedEdits')}
                              </span>
                              <Button variant="outline" onClick={discardChanges} disabled={savingDraft} data-testid="workflow-drawer-discard">
                                {t('panels.drawer.saveBar.discard')}
                              </Button>
                              <Button className="bg-primary hover:bg-primary/90" onClick={() => void saveSelected()} disabled={hasValidationErrors || savingDraft} data-testid="workflow-drawer-save">
                                {savingDraft ? <LoaderCircle className="size-3 animate-spin" /> : null}
                                {t('panels.drawer.saveBar.save')}
                              </Button>
                            </div>
                          ) : null}
                          onClose={() => setDrawerOpen(false)}
                        >
                          {selectedNodeKind === 'trigger' ? (
                            <DrawerSection title={t('panels.drawer.trigger.section')}>
                              {/* Event picker is shared by every trigger type
                                  — switching it commits immediately so the
                                  rest of this section (table picker vs cron
                                  panel) flips with the same click. The
                                  options list mirrors the 5 enabled types
                                  in TriggerPicker (button_clicked stays
                                  gated until its runtime lands). */}
                              <DrawerField label={t('panels.drawer.trigger.eventLabel')}>
                                <select
                                  className={inputClassName}
                                  value={selected?.trigger.type || 'record_created'}
                                  onChange={(event) => {
                                    const next = event.target.value as
                                      | 'record_created'
                                      | 'record_updated'
                                      | 'record_created_or_updated'
                                      | 'record_date_reached'
                                      | 'scheduled_time'
                                    void setTriggerType(next)
                                  }}
                                  disabled={savingDraft}
                                  data-testid="workflow-home-trigger-type"
                                >
                                  <option value="record_created">{t('panels.drawer.titles.whenRecordCreated')}</option>
                                  <option value="record_created_or_updated">{t('panels.drawer.titles.whenRecordCreatedOrUpdated')}</option>
                                  <option value="record_updated">{t('panels.drawer.titles.whenRecordUpdated')}</option>
                                  <option value="record_date_reached">{t('panels.drawer.titles.whenRecordDateReached')}</option>
                                  <option value="scheduled_time">{t('panels.drawer.titles.whenScheduledTime')}</option>
                                </select>
                              </DrawerField>
                              {selected?.trigger.type === 'scheduled_time' ? (
                                // scheduled_time has no table binding — the
                                // trigger source is a clock, not a row event.
                                // The drawer collapses to the cron picker.
                                // We deliberately omit the Filter row too:
                                // nothing to filter when the trigger has no
                                // input record. Server-side validation
                                // surfaces a "trigger_schedule_invalid"
                                // diagnostic for malformed cron — we pluck
                                // it off serverValidation and feed it to
                                // the panel so the user sees the parser's
                                // own error text.
                                <ScheduledTriggerPropertiesPanel
                                  cron={selected?.trigger.schedule?.cron || ''}
                                  timezone={selected?.trigger.schedule?.timezone}
                                  onChange={(next) => { void setTriggerSchedule(next) }}
                                  disabled={savingDraft}
                                  error={serverValidation.errors.find((issue) => issue.code === 'trigger_schedule_invalid' || issue.code === 'trigger_schedule_empty')?.hint
                                    || serverValidation.errors.find((issue) => issue.code === 'trigger_schedule_invalid' || issue.code === 'trigger_schedule_empty')?.message}
                                  timezoneError={serverValidation.errors.find((issue) => issue.code === 'trigger_schedule_timezone_invalid')?.hint
                                    || serverValidation.errors.find((issue) => issue.code === 'trigger_schedule_timezone_invalid')?.message}
                                />
                              ) : (
                                <>
                                  <DrawerField
                                    label={t('panels.drawer.trigger.tableLabel')}
                                    hint={selected?.trigger.tableId ? undefined : t('panels.drawer.trigger.tableHint')}
                                  >
                                    <TriggerTableSelect
                                      value={selected?.trigger.tableId || ''}
                                      options={triggerTableOptions}
                                      onChange={(nextTableId) => { void setTriggerTable(nextTableId) }}
                                      disabled={savingDraft}
                                      testId="workflow-home-trigger-table"
                                    />
                                  </DrawerField>
                                  <DrawerField label={t('panels.drawer.trigger.requiredFieldsLabel')} hint={t('panels.drawer.trigger.requiredFieldsHint')}>
                                    <TriggerRequiredFieldsPanel
                                      value={selected?.trigger.requiredFields || []}
                                      schema={selectedSchema}
                                      onChange={(next) => { void setTriggerRequiredFields(next) }}
                                      disabled={savingDraft}
                                    />
                                  </DrawerField>
                                </>
                              )}
                            </DrawerSection>
                          ) : selectedNodeKind === 'filter' && selectedGraphNode ? (
                            <FilterPropertiesPanel
                              conditions={filterConditions}
                              mode={filterMode}
                              availableFields={availableFilterFields}
                              expressionPreview={compileFilterExpression(filterConditions, filterMode)}
                              onChange={({ conditions, mode }) => {
                                setFilterDryRun(null)
                                setGraphNodes((current) => current.map((n) => {
                                  if (n.nodeId !== selectedGraphNode.nodeId) return n
                                  return {
                                    ...n,
                                    config: {
                                      ...n.config,
                                      mode,
                                      expression: compileFilterExpression(conditions, mode),
                                    },
                                  }
                                }))
                              }}
                              onDryRun={handleFilterDryRun}
                              dryRun={filterDryRun}
                              dryRunLoading={filterDryRunLoading}
                            />
                          ) : (
                            draft.actionType === 'add_record' ? (
                              <>
                                <AddRecordActionPropertiesPanel
                                  config={draft.addRecord || null}
                                  tableOptions={triggerTableOptions}
                                  targetSchema={draft.addRecord?.targetTableId ? schemaByTableId[draft.addRecord.targetTableId] || null : null}
                                  sourceSchema={selectedSchema}
                                  sourceNodeId={selected.trigger.nodeId || 'trigger_1'}
                                  sourceNodeTitle="1. Trigger"
                                  triggerTableId={selected.trigger.tableId}
                                  onChange={(next) => setDraft((current) => ({ ...current, addRecord: next }))}
                                  disabled={savingDraft}
                                  error={(validation.addRecordTarget ? t(`panels.home.validation.${validation.addRecordTarget}`) : '')
                                    || serverValidation.errors.find((issue) => issue.code === 'action_add_record_target_missing')?.message
                                    || serverValidation.errors.find((issue) => issue.code === 'action_add_record_fields_empty')?.message
                                    || serverValidation.errors.find((issue) => issue.code === 'add_record_target_equals_trigger_table')?.message}
                                />
                                <DrawerSection title={t('panels.addRecord.testSection')}>
                                  <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="workflow-add-record-test-step">
                                    <p className="m-0 text-xs text-muted-foreground">
                                      {selected.trigger.type === 'scheduled_time'
                                        ? t('panels.addRecord.scheduledTestDescription', { target: selectedAddRecordTargetLabel })
                                        : t('panels.addRecord.testDescription', { target: selectedAddRecordTargetLabel })}
                                    </p>
                                    <div className="mt-2">
                                      {selected.trigger.type === 'scheduled_time' ? (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          data-testid="workflow-add-record-run-now"
                                          disabled={nodeTest.status === 'running' || hasValidationErrors || isDirty}
                                          onClick={() => {
                                            void nodeTest.run(selected.id, selected.action.nodeId || 'action_1')
                                          }}
                                        >
                                          {nodeTest.status === 'running'
                                            ? <LoaderCircle className="size-4 animate-spin" />
                                            : <Play className="size-4" />}
                                          {t('panels.addRecord.runNow')}
                                        </Button>
                                      ) : (
                                        <SampleRowPicker
                                          documentId={parseIdAsNumber(selected.trigger.documentId)}
                                          tableId={parseIdAsNumber(selected.trigger.tableId)}
                                          disabled={nodeTest.status === 'running' || hasValidationErrors || isDirty}
                                          onPick={(values) => {
                                            void nodeTest.run(
                                              selected.id,
                                              selected.action.nodeId || 'action_1',
                                              { triggerFields: values },
                                            )
                                          }}
                                        />
                                      )}
                                    </div>
                                    {isDirty ? (
                                      <p className="mt-2 text-[11px] text-warning-foreground">{t('panels.addRecord.saveBeforeTest')}</p>
                                    ) : null}
                                    {nodeTest.status === 'done' && nodeTest.result?.output?.recordId ? (
                                      <div data-testid="workflow-add-record-test-status" className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground">
                                        {t('panels.addRecord.testCreated', {
                                          target: selectedAddRecordTargetLabel,
                                          recordId: nodeTest.result.output.recordId,
                                        })}
                                      </div>
                                    ) : null}
                                    {nodeTest.status === 'error' ? (
                                      <div data-testid="workflow-add-record-test-error" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                                        {nodeTest.error}
                                      </div>
                                    ) : null}
                                  </div>
                                </DrawerSection>
                              </>
                            ) : ['update_record', 'lookup_record', 'transform_record'].includes(draft.actionType) ? (
                              <>
                                <RecordActionPropertiesPanel
                                  actionType={draft.actionType as 'update_record' | 'lookup_record' | 'transform_record'}
                                  updateRecord={draft.updateRecord}
                                  lookupRecord={draft.lookupRecord}
                                  transformRecord={draft.transformRecord}
                                  sourceSchema={selectedSchema}
                                  sourceNodeId={selected.trigger.nodeId || 'trigger_1'}
                                  tableOptions={triggerTableOptions}
                                  schemaByTableId={schemaByTableId}
                                  onUpdateRecordChange={(updateRecord) => setDraft((current) => ({ ...current, updateRecord }))}
                                  onLookupRecordChange={(lookupRecord) => setDraft((current) => ({ ...current, lookupRecord }))}
                                  onTransformRecordChange={(transformRecord) => setDraft((current) => ({ ...current, transformRecord }))}
                                  error={validation.recordAction ? t(`panels.home.validation.${validation.recordAction}`) : ''}
                                />
                                <DrawerSection title={t('panels.recordActions.testSection')}>
                                  <div className="rounded-lg border border-border bg-muted/40 p-3">
                                    <p className="m-0 text-xs text-muted-foreground">{t('panels.recordActions.testDescription')}</p>
                                    <div className="mt-2">
                                      <SampleRowPicker
                                        documentId={parseIdAsNumber(selected.trigger.documentId)}
                                        tableId={parseIdAsNumber(selected.trigger.tableId)}
                                        disabled={nodeTest.status === 'running' || hasValidationErrors || isDirty}
                                        onPick={(values, record) => {
                                          void nodeTest.run(selected.id, selected.action.nodeId || 'action_1', {
                                            triggerFields: values,
                                            recordId: String(record.id),
                                          })
                                        }}
                                      />
                                    </div>
                                    {nodeTest.status === 'done' ? (
                                      <div className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground" data-testid="workflow-record-action-test-status">
                                        {nodeTest.result?.output?.matched === false
                                          ? t('panels.recordActions.noMatch')
                                          : t('panels.recordActions.testUpdated')}
                                      </div>
                                    ) : null}
                                    {nodeTest.status === 'error' ? (
                                      <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">{nodeTest.error}</div>
                                    ) : null}
                                  </div>
                                </DrawerSection>
                              </>
                            ) : (
                            <>
                              <DrawerSection title={t('panels.drawer.channel.section')}>
                                <DrawerField
                                  label={t('panels.drawer.channel.connectionLabel')}
                                  action={(
                                    <button
                                      type="button"
                                      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary"
                                      onClick={() => {
                                        connectionsModal.openCreate()
                                      }}
                                      data-testid="workflow-home-new-connection"
                                    >
                                      <Plus className="size-3" />
                                      {t('panels.drawer.channel.newConnection')}
                                    </button>
                                  )}
                                >
                                  <select
                                    className={inputClassName}
                                    value={draft.connectionId}
                                    onChange={(event) => setDraft((current) => ({ ...current, connectionId: event.target.value }))}
                                    data-testid="workflow-home-connection"
                                  >
                                    <option value="">{t('panels.home.nodeCard.noConnectionSelected')}</option>
                                    {connections.map((connection) => (
                                      <option key={connection.id} value={connection.id}>
                                        {connection.name} - {String(connection.settings.from || connection.settings.host || 'Email SMTP')}
                                      </option>
                                    ))}
                                  </select>
                                  {draft.connectionId ? (
                                    <div className="mt-1 flex gap-2 text-[11px]">
                                      <button
                                        type="button"
                                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground hover:bg-muted"
                                        onClick={() => {
                                          connectionsModal.openEdit(draft.connectionId)
                                        }}
                                        data-testid="workflow-home-edit-connection"
                                      >
                                        {t('panels.drawer.channel.editConnection')}
                                      </button>
                                    </div>
                                  ) : null}
                                </DrawerField>
                              </DrawerSection>

                              <DrawerSection title={t('panels.drawer.email.section')}>
                                <DrawerField
                                  label={t('panels.drawer.email.toLabel')}
                                  error={validation.to ? t(`panels.home.validation.${validation.to}`) : ''}
                                  action={(
                                    <button
                                      type="button"
                                      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary"
                                      onClick={() => void sendInlineTest()}
                                      disabled={sendTest.status === 'running' || Boolean(validation.to)}
                                      data-testid="workflow-home-send-test"
                                    >
                                      {sendTest.status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : <Send className="size-3" />}
                                      {t('panels.drawer.email.sendTestEmail')}
                                    </button>
                                  )}
                                >
                                  <input className={inputClassName} value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} data-testid="workflow-home-to" />
                                </DrawerField>
                                {sendTest.status === 'done' && sendTest.result ? (
                                  <div data-testid="send-test-status" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success-foreground">
                                    {t('panels.drawer.email.testDelivered', { to: sendTest.result.input.to })}
                                  </div>
                                ) : null}
                                {sendTest.status === 'error' ? (
                                  <div data-testid="send-test-error" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {sendTest.error}
                                  </div>
                                ) : null}
                                <DrawerField label={t('panels.drawer.email.subjectLabel')} hint={!selected?.trigger.tableId ? t('panels.drawer.email.pickTableFirstHint') : undefined} error={validation.subject ? t(`panels.home.validation.${validation.subject}`) : ''}>
                                  <TemplateTokenInput
                                    value={draft.subject}
                                    schema={selectedSchema}
                                    triggerNodeId={selected.trigger.nodeId}
                                    triggerNodeTitle="1. Trigger"
                                    multiline={false}
                                    testId="workflow-home-subject"
                                    disabled={!selected?.trigger.tableId}
                                    placeholder={!selected?.trigger.tableId ? t('panels.drawer.email.pickTableFirstPlaceholder') : undefined}
                                    onChange={(subject) => setDraft((current) => ({ ...current, subject }))}
                                  />
                                </DrawerField>
                                <DrawerField label={t('panels.drawer.email.bodyLabel')} hint={!selected?.trigger.tableId ? t('panels.drawer.email.pickTableFirstHint') : t('panels.drawer.email.bodyHint')} error={validation.body ? t(`panels.home.validation.${validation.body}`) : ''}>
                                  <TemplateTokenInput
                                    value={draft.body}
                                    schema={selectedSchema}
                                    triggerNodeId={selected.trigger.nodeId}
                                    triggerNodeTitle="1. Trigger"
                                    multiline
                                    testId="workflow-home-body"
                                    disabled={!selected?.trigger.tableId}
                                    placeholder={!selected?.trigger.tableId ? t('panels.drawer.email.pickTableFirstPlaceholder') : undefined}
                                    onChange={(body) => setDraft((current) => ({ ...current, body }))}
                                  />
                                </DrawerField>
                              </DrawerSection>

                              <DrawerSection title={t('panels.drawer.testStep.section')}>
                                <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="workflow-drawer-test-step">
                                  <p className="m-0 text-xs text-muted-foreground">
                                    {t('panels.drawer.testStep.descriptionPre')}{selectedTableLabel}{t('panels.drawer.testStep.descriptionMid')}<code className="rounded bg-card px-1 py-0.5 text-[10px] text-primary">manual.test</code>{t('panels.drawer.testStep.descriptionPost')}
                                  </p>
                                  <div className="mt-2 flex items-center gap-2">
                                    <Button
                                      className="h-8 bg-primary px-3 hover:bg-primary/90"
                                      onClick={() => void nodeTest.run(selected.id, selected.action.nodeId || 'action_1', { to: draft.to })}
                                      disabled={nodeTest.status === 'running' || Boolean(validation.to)}
                                      data-testid="workflow-drawer-run-with-sample"
                                    >
                                      {nodeTest.status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}
                                      {t('panels.drawer.testStep.runWithSample')}
                                    </Button>
                                  </div>
                                  {nodeTest.status === 'done' && nodeTest.result?.input ? (
                                    <div data-testid="workflow-drawer-test-step-status" className="mt-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success-foreground">
                                      {t('panels.drawer.testStep.testDelivered', { to: nodeTest.result.input.to })}
                                    </div>
                                  ) : null}
                                  {nodeTest.status === 'error' ? (
                                    <div data-testid="workflow-drawer-test-step-error" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                                      {nodeTest.error}
                                    </div>
                                  ) : null}
                                </div>
                              </DrawerSection>
                            </>
                            )
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
                        // Jump back to Edit workflow with the failing node
                        // selected and the Drawer open. The user lands on
                        // the same spot the StatusBanner Fix CTA targets.
                        setSelectedNodeId(nodeId)
                        setActiveTab('configuration')
                        setDrawerOpen(true)
                      }}
                    />
                  ) : null}

                  {activeTab === 'logs' ? (
                    <LogsView status={selectedRuns.status} runs={visibleRuns} error={selectedRuns.error} />
                  ) : null}
                </div>

                {isDirty ? (
                  <div
                    data-testid="workflow-home-save-bar"
                    // The drawer is rendered inside the same absolute-positioning
                    // ancestor as this bar, so a plain `right-6` would have the
                    // save bar overlap (and intercept clicks on) the drawer's own
                    // save row. Inset the right edge past the drawer width when
                    // it's open so both save bars stay clickable side by side.
                    className={`absolute bottom-4 left-6 z-20 flex items-center justify-between rounded-xl bg-popover px-4 py-3 text-sm text-popover-foreground shadow-floating ${drawerOpen ? 'right-[376px]' : 'right-6'}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full bg-warning" />
                      <span className="truncate">{t('panels.drawer.pageSaveBar.messagePrefix', { fields: dirtyFields.join(', ') })}</span>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" className="border-border bg-transparent text-popover-foreground hover:bg-muted/80" onClick={discardChanges} disabled={savingDraft} data-testid="workflow-home-discard">
                        {t('panels.drawer.pageSaveBar.discard')}
                      </Button>
                      <Button className="bg-primary hover:bg-primary/90" onClick={() => void saveSelected()} disabled={hasValidationErrors || savingDraft} data-testid="workflow-home-save">
                        {savingDraft ? <LoaderCircle className="size-4 animate-spin" /> : null}
                        {t('panels.drawer.pageSaveBar.save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="sr-only" data-testid="workflow-home-save-bar-hidden" />
                )}
              </div>
            ) : status === 'done' ? (
              // No left rail to pick from — the route + index page own
              // workflow selection, so this surface only ever renders an
              // empty state (or an inline picker for kitable-scoped
              // mounts whose scope has workflows but none was preselected).
              // Shape depends on whether a kitable scope is pinned:
              //   * scoped (kitable Workflows tab) + zero scoped rows:
              //     single-CTA card so the user goes through the mode
              //     chooser dialog — templates need the dialog's table
              //     picker to bind correctly under this kitable.
              //   * unscoped (deep-linked /workflow/{id} that doesn't
              //     resolve, or post-streaming with no surviving row):
              //     the full WorkflowHomeLauncher hero.
              //   * scoped + has rows but none selected: inline picker
              //     so the user doesn't have to hunt the sidebar tree.
              scopedWorkflows.length === 0 ? (
                scopedKitablePath ? (
                  <div
                    className="flex h-full items-center justify-center px-8 text-center"
                    data-testid="kitable-workflows-empty"
                  >
                    <div className="max-w-md">
                      <FileText className="mx-auto mb-4 size-8 text-primary" />
                      <h1 className="text-xl font-semibold">{t('panels.home.emptyCreateTitle')}</h1>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {t('panels.home.emptyCreateHint')}
                      </p>
                      <div className="mt-5 flex justify-center">
                        <Button
                          className="bg-primary hover:bg-primary/90"
                          onClick={modeDialog.openDialog}
                          data-testid="kitable-workflows-create-cta"
                        >
                          <Plus className="mr-1 size-4" />
                          {t('panels.home.emptyCreateButton')}
                        </Button>
                      </div>
                      {launcher.error ? (
                        <p
                          className="mt-3 text-xs text-destructive"
                          data-testid="kitable-workflows-error"
                        >
                          {launcher.error}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <WorkflowHomeLauncher
                    onGenerateWithAi={() => {
                      // Drive the AI flow through the standalone
                      // /workflow/new?mode=ai surface. Even without a
                      // pre-bound table the route now lands on the
                      // AI prompt page (mode 'ai-no-context') instead
                      // of looping back to this launcher, so the
                      // click resolves into something visible.
                      openWorkflowRoute(null, { mode: 'ai' })
                    }}
                    onStartFromScratch={() => void launcher.runScratch()}
                    onTemplateSelect={(template) => void launcher.runTemplate(template)}
                    onAgentClick={launcher.handleAgent}
                    busyAction={launcher.busyAction}
                    busyTemplateId={launcher.busyTemplateId}
                    errorMessage={launcher.error}
                    scopeLabel={scopedKitableLabel || undefined}
                  />
                )
              ) : (
                <div className="mx-auto w-full max-w-3xl px-6 py-6" data-testid="kitable-workflows-picker">
                  <div className="overflow-hidden rounded-xl border border-border bg-card">
                    {scopedWorkflows.map((workflow) => {
                      const latestRun = latestRuns[workflow.id] || null
                      const itemStatus = workflowStatus(workflow, latestRun)
                      return (
                        <div
                          key={workflow.id}
                          data-testid="kitable-workflows-picker-item"
                          className="border-b border-border/60 last:border-b-0 bg-card hover:bg-muted/40"
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            className="w-full px-4 py-3 text-left"
                            onClick={() => handleSelectListItem(workflow.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                handleSelectListItem(workflow.id)
                              }
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-sm font-medium">{workflow.name || 'Untitled workflow'}</span>
                              <StatusPill status={itemStatus} />
                            </div>
                            <div className="mt-1.5 grid gap-0.5 text-[11px] text-muted-foreground">
                              <FlowLine label={t('panels.home.list.flowWhen')} value={triggerLabel(workflow, tableLabels, t)} />
                              <FlowLine label={t('panels.home.list.flowThen')} value={t('panels.home.nodeCard.actionSendEmail')} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
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
