import { PlusIcon as Plus } from '@kition/tessera-icons/react'
import { InlineError } from '@/components/states'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@kition/tessera-ui'
import type { WorkflowDefinition } from '@/api/workflows'
import { WORKFLOW_CHANGED_EVENT, listWorkflowRuns, listWorkflows } from '@/api/workflows'
import {
  type TableLabel,
  resolveWorkflowTableFilePath,
  tableLabelFor,
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
import { openWorkflowRoute, openWorkflowDetail, type WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import { listTableFiles } from '@/api/kitTables'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { ensureOnboardingWorkflow } from '@/features/workflow/lib/ensureOnboardingWorkflow'

export interface WorkflowIndexPageProps {
  /** Scope to a specific table file. Filters list and query to workflows bound
   *  to tables within this document. */
  scopedTablePath?: string
  /** Workspace root for scopedTablePath resolution. */
  rootPath?: string
  /** Preview workflow being built via AI, to pin at top of list */
  streamingPreview?: any | null
  /** Called when user clicks a row */
  onSelectWorkflow: (workflowId: string, tableFilePath?: string) => void
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
  scopedTablePath,
  rootPath,
  streamingPreview,
  onSelectWorkflow,
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
  // A table file's tab creates workflows for that file: its tables are the dialog's choices.
  const [tableOptions, setTableOptions] = useState<WorkflowRouteContext[]>([])
  useEffect(() => {
    if (!modeDialogOpen || !scopedTablePath) return
    let current = true
    void listTableFiles().then((result) => {
      if (!current) return
      const file = (result.files || []).find((item) => item.path === scopedTablePath)
      setTableOptions((file?.tables || []).map((table) => ({
        documentPath: scopedTablePath,
        tableId: String(table.id),
        tableName: table.title || table.name,
      })))
    }, () => {
      if (current) setTableOptions([])
    })
    return () => {
      current = false
    }
  }, [modeDialogOpen, scopedTablePath])
  const [onboardingPreparation, setOnboardingPreparation] = useState<{
    key: string
    status: 'checking' | 'done'
  } | null>(null)
  const onboardingKey = scopedTablePath ? `${rootPath || ''}\u0000${scopedTablePath}` : ''
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
  // Table file tabs stay mounted while another tab is active, so mount-only
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

  // Onboarding table files ship runnable scenarios, not just gallery cards. A
  // single new scenario opens directly; table files with several stay on the
  // list so the user can compare the available workflows.
  useEffect(() => {
    if (!scopedTablePath || state.status !== 'done') return
    const key = `${rootPath || ''}\u0000${scopedTablePath}`
    if (onboardingAttemptRef.current === key) return
    onboardingAttemptRef.current = key
    setOnboardingPreparation({ key, status: 'checking' })
    void ensureOnboardingWorkflow({
      tableFilePath: scopedTablePath,
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
  }, [loadWorkflows, rootPath, scopedTablePath, state.status])

  // Scope workflows to the table file if provided
  const scopedWorkflows = useMemo(() => {
    if (!scopedTablePath) return state.workflows
    return state.workflows.filter((workflow) => resolveWorkflowTableFilePath(workflow) === scopedTablePath)
  }, [state.workflows, scopedTablePath])
  const onboardingPending = Boolean(scopedTablePath)
    && state.status === 'done'
    && (onboardingPreparation?.key !== onboardingKey || onboardingPreparation.status !== 'done')

  const handleCreateWorkflow = (choice: WorkspaceWorkflowCreateModeChoice) => {
    if (choice.kind === 'chat') {
      setModeDialogOpen(false)
      openWorkflowRoute(choice.context, { mode: 'ai' })
    } else if (choice.kind === 'template') {
      void launcher.runTemplate(choice.template, choice.context)
    } else if (choice.kind === 'scratch') {
      void launcher.runScratch(choice.context)
    }
  }

  const openCreateWorkflow = () => {
    launcher.clearError()
    setModeDialogOpen(true)
  }

  const handleRowClick = (workflowId: string) => {
    const workflow = state.workflows.find((item) => item.id === workflowId)
    const tableFilePath = workflow ? resolveWorkflowTableFilePath(workflow) : ''
    onSelectWorkflow(workflowId, tableFilePath || undefined)
  }

  return (
    <div data-testid="workflow-index-page" className="flex h-full flex-col bg-card">
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {state.status === 'loading' || tableLabelsStatus === 'loading' || onboardingPending ? (
          <WorkflowListSkeleton label={t('panels.home.list.loading')} />
        ) : state.status === 'error' ? (
          <InlineError className="m-3" message={state.error} />
        ) : scopedWorkflows.length ? (
          <WorkflowDefinitionTable
            workflows={scopedWorkflows}
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
              variant="primary"
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
          context={tableOptions[0] ?? null}
          tableOptions={tableOptions}
          onSelect={handleCreateWorkflow}
          busyKind={launcher.busyAction === 'ai' ? 'chat' : launcher.busyAction}
          busyTemplateId={launcher.busyTemplateId}
          errorMessage={launcher.error}
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
  latestRuns,
  tableLabels,
  onRowClick,
}: {
  workflows: WorkflowDefinition[]
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
  const tableLabel = tableLabelFor(tableLabels, workflow.trigger?.documentPath, tableId)
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
