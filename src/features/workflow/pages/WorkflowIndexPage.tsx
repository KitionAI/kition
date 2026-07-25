import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import type { WorkflowDefinition } from '@/features/workflow/api'
import { WORKFLOW_CHANGED_EVENT, listWorkflowRuns, listWorkflows } from '@/features/workflow/api'
import {
  type TableLabel,
  resolveWorkflowKitablePath,
  triggerLabel,
  workflowStatus,
} from '@/features/workflow/lib/workflowDraft'
import {
  WorkspaceWorkflowCreateModeDialog,
  type WorkspaceWorkflowCreateModeChoice,
} from '@/features/workspace/components/WorkspaceWorkflowCreateModeDialog'
import { relativeTime, type RelativeTimeStrings } from '@/features/workflow/pages/WorkflowHomePageRunHistory'
import { useWorkflowLauncherState } from '@/features/workflow/hooks/useWorkflowLauncherState'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { openWorkflowRoute, openWorkflowDetail } from '@/features/workflow/lib/openWorkflowRoute'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { ensureOnboardingWorkflow } from '@/features/workflow/lib/ensureOnboardingWorkflow'
import { EMAIL_AUTOMATION_TABLE_PATH } from '@/features/onboarding/upgradeOnboardingPack'
import { EmailSyncOnboardingWorkflowPage } from '@/features/emailSync/EmailSyncOnboardingWorkflowPage'
import { EmailSyncWorkflowPage } from '@/features/emailSync/EmailSyncWorkflowPage'
import { EmailSyncWorkflowTableRow } from '@/features/emailSync/EmailSyncWorkflowTableRow'
import { EmailSyncWorkflowEditor } from '@/features/emailSync/EmailSyncWorkflowEditor'
import {
  consumeEmailSyncSetupRequest,
  EMAIL_SYNC_SETUP_REQUEST_EVENT,
} from '@/features/emailSync/setupRequest'
import {
  normalizeEmailSyncTablePath,
  useTableEmailSyncWorkflows,
} from '@/features/emailSync/useTableEmailSyncWorkflows'
import type { EmailSyncRun, EmailSyncWorkflow } from '@/features/emailSync/api'

export interface WorkflowIndexPageProps {
  /** Scope to a specific kitable. Filters list and query to workflows bound
   *  to tables within this document. */
  scopedKitablePath?: string
  /** Workspace root for scopedKitablePath resolution. */
  rootPath?: string
  /** Preview workflow being built via AI, to pin at top of list */
  streamingPreview?: any | null
  /** Called when user clicks a row */
  onSelectWorkflow: (workflowId: string, kitablePath?: string) => void
  /** Context-aware create entry supplied by Kitable workspace tabs. */
  onCreateWorkflow?: () => void
  /** Called when close button clicked (only present in certain mounts) */
  onClose?: () => void
  /** Open create-mode dialog on mount */
  initialModeDialogOpen?: boolean
}

interface IndexPageState {
  workflows: WorkflowDefinition[]
  latestRuns: Record<string, WorkflowRunRecord | null>
  status: 'loading' | 'done' | 'error'
  error: string
}

const timeStrings: RelativeTimeStrings = {
  justNow: 'just now',
  minutesAgo: (n) => `${n}m ago`,
  hoursAgo: (n) => `${n}h ago`,
  daysAgo: (n) => `${n}d ago`,
}

export function WorkflowIndexPage({
  scopedKitablePath,
  rootPath,
  streamingPreview,
  onSelectWorkflow,
  onCreateWorkflow,
  onClose,
  initialModeDialogOpen = false,
}: WorkflowIndexPageProps) {
  const { t } = useTranslation('workflow')
  const { labels: tableLabels, status: tableLabelsStatus } = useWorkflowTableLabels(rootPath)
  const [state, setState] = useState<IndexPageState>({
    workflows: [],
    latestRuns: {},
    status: 'loading',
    error: '',
  })
  const [modeDialogOpen, setModeDialogOpen] = useState(initialModeDialogOpen)
  const [emailSyncEditorPath, setEmailSyncEditorPath] = useState('')
  const emailSync = useTableEmailSyncWorkflows(scopedKitablePath)
  const [onboardingPreparation, setOnboardingPreparation] = useState<{
    key: string
    status: 'checking' | 'done'
  } | null>(null)
  const onboardingKey = scopedKitablePath ? `${rootPath || ''}\u0000${scopedKitablePath}` : ''
  const loadVersionRef = useRef(0)
  const onboardingAttemptRef = useRef('')
  const onboardingScopeKeyRef = useRef(onboardingKey)
  const mountedRef = useRef(true)
  const onSelectWorkflowRef = useRef(onSelectWorkflow)
  const workflowsRef = useRef(state.workflows)
  const translateRef = useRef(t)
  onboardingScopeKeyRef.current = onboardingKey
  onSelectWorkflowRef.current = onSelectWorkflow
  workflowsRef.current = state.workflows
  translateRef.current = t
  const isEmailAutomationOnboardingTable = Boolean(scopedKitablePath)
    && normalizeEmailSyncTablePath(scopedKitablePath!) === EMAIL_AUTOMATION_TABLE_PATH

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const loadWorkflows = useCallback(async () => {
    const loadVersion = ++loadVersionRef.current
    setState((s) => ({ ...s, status: 'loading', error: '' }))
    try {
      const items = await listWorkflows()
      const runs = await Promise.all(
        items.map(async (item) => {
          const recs = await listWorkflowRuns(item.id, 1).catch(() => [])
          return [item.id, recs[0] || null] as const
        }),
      )
      if (loadVersion !== loadVersionRef.current) return
      setState((s) => ({
        ...s,
        workflows: items,
        latestRuns: Object.fromEntries(runs),
        status: 'done',
      }))
    } catch (err) {
      if (loadVersion !== loadVersionRef.current) return
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to load workflows',
      }))
    }
  }, [])
  const launcher = useWorkflowLauncherState({
    refresh: loadWorkflows,
    onCreated: (workflowId) => {
      setModeDialogOpen(false)
      onSelectWorkflow(workflowId)
    },
  })

  // Keep already-mounted index tabs in sync with creates, edits and deletes.
  // Kitable tabs stay mounted while another tab is active, so mount-only
  // loading otherwise leaves the index showing the snapshot from before a
  // template was created.
  useEffect(() => {
    const handleWorkflowChanged = () => {
      void loadWorkflows()
    }
    void loadWorkflows()
    window.addEventListener(WORKFLOW_CHANGED_EVENT, handleWorkflowChanged)
    return () => {
      loadVersionRef.current += 1
      window.removeEventListener(WORKFLOW_CHANGED_EVENT, handleWorkflowChanged)
    }
  }, [loadWorkflows])

  useEffect(() => {
    const pendingRequest = scopedKitablePath
      ? consumeEmailSyncSetupRequest(scopedKitablePath)
      : null
    if (pendingRequest) setEmailSyncEditorPath(pendingRequest.tablePath)

    function handleEmailSyncSetup(event: Event) {
      const tablePath = String(
        (event as CustomEvent<{ tablePath?: string }>).detail?.tablePath || '',
      ).trim()
      if (tablePath && tablePath === scopedKitablePath) {
        setModeDialogOpen(false)
        setEmailSyncEditorPath(tablePath)
      }
    }
    window.addEventListener(EMAIL_SYNC_SETUP_REQUEST_EVENT, handleEmailSyncSetup)
    return () => window.removeEventListener(EMAIL_SYNC_SETUP_REQUEST_EVENT, handleEmailSyncSetup)
  }, [scopedKitablePath])

  // Onboarding table files ship runnable scenarios, not just gallery cards. A
  // single new scenario opens directly; table files with several stay on the
  // list so the user can compare the available workflows.
  useEffect(() => {
    if (!scopedKitablePath || state.status !== 'done') return
    const key = `${rootPath || ''}\u0000${scopedKitablePath}`
    if (onboardingAttemptRef.current === key) return
    onboardingAttemptRef.current = key
    if (isEmailAutomationOnboardingTable) {
      setOnboardingPreparation({ key, status: 'done' })
      return
    }
    setOnboardingPreparation({ key, status: 'checking' })
    void ensureOnboardingWorkflow({
      scopedKitablePath,
      rootPath,
      workflows: workflowsRef.current,
      translate: translateRef.current,
    }).then((result) => {
      if (!mountedRef.current || onboardingScopeKeyRef.current !== key) return
      setOnboardingPreparation({ key, status: 'done' })
      if (result.created.length === 1) {
        onSelectWorkflowRef.current(result.created[0].id)
      } else if (result.created.length > 1) {
        void loadWorkflows()
      }
    }).catch((err) => {
      if (!mountedRef.current || onboardingScopeKeyRef.current !== key) return
      console.warn('onboarding workflow initialization failed', err)
      setOnboardingPreparation({ key, status: 'done' })
    })
  }, [isEmailAutomationOnboardingTable, loadWorkflows, rootPath, scopedKitablePath, state.status])

  // Scope workflows to kitable if provided
  const scopedWorkflows = useMemo(() => {
    if (!scopedKitablePath) return state.workflows
    return state.workflows.filter((workflow) => {
      const tableId = workflow.trigger?.tableId
        || workflow.action?.addRecord?.targetTableId
        || ''
      const label = tableId ? tableLabels[tableId] : null
      return label?.documentPath === scopedKitablePath
    })
  }, [state.workflows, scopedKitablePath, tableLabels])
  const onboardingPending = Boolean(scopedKitablePath)
    && state.status === 'done'
    && (onboardingPreparation?.key !== onboardingKey || onboardingPreparation.status !== 'done')

  const handleCreateWorkflow = (choice: WorkspaceWorkflowCreateModeChoice) => {
    if (choice.kind === 'chat') {
      setModeDialogOpen(false)
      openWorkflowRoute(null, { mode: 'ai' })
    } else if (choice.kind === 'template') {
      void launcher.runTemplate(choice.template)
    } else if (choice.kind === 'scratch') {
      void launcher.runScratch()
    }
  }

  const openCreateWorkflow = () => {
    if (onCreateWorkflow) {
      onCreateWorkflow()
      return
    }
    launcher.clearError()
    setModeDialogOpen(true)
  }

  const handleRowClick = (workflowId: string) => {
    const emailWorkflow = emailSync.workflows.find((item) => item.id === workflowId)
    if (emailWorkflow) {
      onSelectWorkflow(workflowId, emailWorkflow.target.table_path)
      return
    }
    const workflow = state.workflows.find((item) => item.id === workflowId)
    const kitablePath = workflow
      ? resolveWorkflowKitablePath(workflow, tableLabels)
      : ''
    onSelectWorkflow(workflowId, kitablePath || undefined)
  }

  if (emailSyncEditorPath) {
    return (
      <EmailSyncWorkflowEditor
        tablePath={emailSyncEditorPath}
        onCancel={() => setEmailSyncEditorPath('')}
        onSaved={(workflow) => {
          setEmailSyncEditorPath('')
          onSelectWorkflow(workflow.id, workflow.target.table_path)
        }}
      />
    )
  }

  const showEmailSyncOnboardingWorkflow = isEmailAutomationOnboardingTable
    && state.status === 'done'
    && tableLabelsStatus === 'done'
    && !onboardingPending
    && emailSync.status === 'ready'
    && scopedWorkflows.length === 0
    && emailSync.workflows.length === 0

  const configuredEmailOnboardingWorkflow = isEmailAutomationOnboardingTable
    && state.status === 'done'
    && tableLabelsStatus === 'done'
    && !onboardingPending
    && emailSync.status === 'ready'
    && scopedWorkflows.length === 0
    && emailSync.workflows.length === 1
      ? emailSync.workflows[0]
      : null

  if (configuredEmailOnboardingWorkflow) {
    return <EmailSyncWorkflowPage workflowId={configuredEmailOnboardingWorkflow.id} />
  }

  if (showEmailSyncOnboardingWorkflow) {
    return (
      <EmailSyncOnboardingWorkflowPage
        tablePath={scopedKitablePath!}
        onSaved={(workflow) => onSelectWorkflow(workflow.id, workflow.target.table_path)}
      />
    )
  }

  return (
    <div data-testid="workflow-index-page" className="flex h-full flex-col bg-card">
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {state.status === 'loading' || tableLabelsStatus === 'loading' || onboardingPending || emailSync.status === 'loading' ? (
          <WorkflowListSkeleton label={t('panels.home.list.loading')} />
        ) : state.status === 'error' ? (
          <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
            {state.error}
          </div>
        ) : scopedWorkflows.length || emailSync.workflows.length ? (
          <WorkflowDefinitionTable
            workflows={scopedWorkflows}
            emailSyncWorkflows={emailSync.workflows}
            emailSyncLatestRuns={emailSync.latestRuns}
            latestRuns={state.latestRuns}
            tableLabels={tableLabels}
            onRowClick={handleRowClick}
          />
        ) : (
          <div
            data-testid="workflow-index-empty"
            className="flex flex-col items-center justify-center h-full gap-3 text-center text-muted-foreground"
          >
            <div className="text-sm">{t('panels.home.list.emptyNone')}</div>
            <Button
              variant="default"
              size="sm"
              data-testid="workflow-index-create"
              onClick={openCreateWorkflow}
            >
              <Plus className="w-4 h-4" />
              {t('buttons.create') || 'Create Workflow'}
            </Button>
          </div>
        )}
      </div>

      {/* Create mode dialog */}
      {modeDialogOpen && (
        <WorkspaceWorkflowCreateModeDialog
          open={modeDialogOpen}
          onOpenChange={setModeDialogOpen}
          context={null}
          onSelect={handleCreateWorkflow}
          busyKind={launcher.busyAction === 'ai' ? 'chat' : launcher.busyAction}
          busyTemplateId={launcher.busyTemplateId}
          errorMessage={launcher.error}
          emailSyncTablePath={scopedKitablePath}
          onSelectEmailSync={(tablePath) => {
            setModeDialogOpen(false)
            setEmailSyncEditorPath(tablePath)
          }}
        />
      )}
    </div>
  )
}

interface WorkflowTableRowProps {
  workflow: WorkflowDefinition
  latestRun: WorkflowRunRecord | null
  tableLabels: Record<string, TableLabel>
  timeStrings: RelativeTimeStrings
  onRowClick: (workflowId: string) => void
}

function WorkflowDefinitionTable({
  workflows,
  emailSyncWorkflows,
  emailSyncLatestRuns,
  latestRuns,
  tableLabels,
  onRowClick,
}: {
  workflows: WorkflowDefinition[]
  emailSyncWorkflows: EmailSyncWorkflow[]
  emailSyncLatestRuns: Record<string, EmailSyncRun | null>
  latestRuns: Record<string, WorkflowRunRecord | null>
  tableLabels: Record<string, TableLabel>
  onRowClick: (workflowId: string) => void
}) {
  const { t } = useTranslation('workflow')
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase bg-muted/40 border-b border-border whitespace-nowrap" style={{ width: '96px' }}>
            {t('common.status')}
          </th>
          <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border">
            {t('common.name')}
          </th>
          <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border whitespace-nowrap" style={{ width: '160px' }}>
            {t('panels.home.list.trigger')}
          </th>
          <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border whitespace-nowrap" style={{ width: '220px' }}>
            {t('panels.home.list.action')}
          </th>
          <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border whitespace-nowrap" style={{ width: '110px' }}>
            {t('panels.home.list.table')}
          </th>
          <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border whitespace-nowrap" style={{ width: '140px' }}>
            {t('panels.home.list.lastRun')}
          </th>
          <th className="text-right px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground bg-muted/40 border-b border-border" style={{ width: '60px' }} />
        </tr>
      </thead>
      <tbody>
        {emailSyncWorkflows.map((workflow) => (
          <EmailSyncWorkflowTableRow
            key={`email-sync:${workflow.id}`}
            workflow={workflow}
            latestRun={emailSyncLatestRuns[workflow.id] || null}
            tablePath={workflow.target.table_path}
            tableTitle={workflow.target.table_id ? tableLabels[String(workflow.target.table_id)]?.tableName : undefined}
            onOpen={() => onRowClick(workflow.id)}
          />
        ))}
        {workflows.map((workflow) => (
          <WorkflowTableRow
            key={workflow.id}
            workflow={workflow}
            latestRun={latestRuns[workflow.id] || null}
            tableLabels={tableLabels}
            timeStrings={timeStrings}
            onRowClick={onRowClick}
          />
        ))}
      </tbody>
    </table>
  )
}

function WorkflowListSkeleton({ label }: { label: string }) {
  const colWidths = ['96px', undefined, '160px', '220px', '110px', '140px', '60px']
  return (
    <div data-testid="workflow-index-skeleton" aria-busy="true" aria-label={label}>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {Array.from({ length: 6 }).map((_, rowIdx) => (
            <tr key={rowIdx} className="border-b border-border/60">
              {colWidths.map((width, colIdx) => (
                <td key={colIdx} className="px-4 py-2.5 align-middle" style={width ? { width } : undefined}>
                  <span
                    className="skeleton block h-4"
                    style={{ width: colIdx === 1 ? '60%' : colIdx === 6 ? '1.25rem' : '70%' }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WorkflowTableRow({
  workflow,
  latestRun,
  tableLabels,
  timeStrings,
  onRowClick,
}: WorkflowTableRowProps) {
  const { t } = useTranslation('workflow')

  // Determine status dot color (token-based so dark mode adapts)
  let dotClass = 'bg-muted-foreground/60'
  let statusText = ''
  let statusPillClass = 'bg-muted text-muted-foreground'
  if (latestRun?.status === 'error') {
    dotClass = 'bg-destructive'
    statusText = t('panels.home.list.statusFailing') || 'Failing'
    statusPillClass = 'bg-destructive/15 text-destructive'
  } else if (workflow.enabled) {
    dotClass = 'bg-success'
    statusText = t('panels.home.list.statusActive') || 'Active'
    statusPillClass = 'bg-success/15 text-success-foreground'
  } else {
    statusText = t('panels.home.list.statusDisabled') || 'Disabled'
  }

  // Extract table name for display
  const tableId = workflow.trigger?.tableId
  const tableLabel = tableId ? tableLabels[tableId] : null
  const tableName = tableLabel?.tableName || '—'

  // Trigger label
  const trigLabel = triggerLabel(workflow, tableLabels, t)

  // Action description
  const actionDesc = workflow.action.to || '—'

  // Last run time
  const lastRunText = latestRun ? relativeTime(latestRun.startedAt, timeStrings) : '—'

  // Red left border for failing workflows
  const failingClass = latestRun?.status === 'error' ? 'border-l-[3px] border-l-destructive' : ''

  return (
    <tr
      data-testid="workflow-index-row"
      data-workflow-id={workflow.id}
      data-workflow-status={latestRun?.status === 'error' ? 'failing' : workflow.enabled ? 'active' : 'disabled'}
      className={`border-b border-border/60 cursor-pointer hover:bg-muted/40 ${failingClass}`}
      onClick={() => onRowClick(workflow.id)}
    >
      <td className="px-4 py-2.5 align-middle">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-[7px] w-[7px] rounded-full ${dotClass}`}
          />
          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusPillClass}`}>
            {statusText}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 align-middle">
        <div className="text-sm font-medium text-foreground max-w-[220px] truncate">
          {workflow.name}
        </div>
      </td>
      <td className="px-4 py-2.5 align-middle text-muted-foreground text-sm">
        {trigLabel}
      </td>
      <td className="px-4 py-2.5 align-middle text-muted-foreground text-sm max-w-[220px] truncate">
        {actionDesc}
      </td>
      <td className="px-4 py-2.5 align-middle text-muted-foreground text-sm">
        {tableName}
      </td>
      <td className="px-4 py-2.5 align-middle text-muted-foreground/80 text-sm whitespace-nowrap">
        {lastRunText}
      </td>
      <td className="px-4 py-2.5 align-middle text-right">
        <button
          className="px-2 py-1 text-xs border border-border rounded-md bg-card text-muted-foreground hover:bg-muted/40"
          onClick={(e) => {
            e.stopPropagation()
            // Menu action — placeholder for now
          }}
        >
          ⋯
        </button>
      </td>
    </tr>
  )
}
