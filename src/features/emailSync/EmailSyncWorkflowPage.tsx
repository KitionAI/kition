import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ListRestart,
  LoaderCircle,
  Mail,
  RefreshCw,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui'
import { useConfirm } from '@/components/confirm'
import { getEmailProvider, resolveEmailProviderId } from '@/features/emailProviders/emailProviderCatalog'
import { NodeCard } from '@/features/workflow/canvas/NodeCard'
import { WorkflowCanvas } from '@/features/workflow/canvas/WorkflowCanvas'
import { PropertiesDrawer } from '@/features/workflow/drawer/PropertiesDrawer'
import { EmailSyncTriggerPanel } from './EmailSyncTriggerPanel'
import { EmailSyncWorkflowEditor } from './EmailSyncWorkflowEditor'
import { CopyableEmailSyncError } from './CopyableEmailSyncError'
import { useEmailSyncTableOptions } from './useEmailSyncTableOptions'
import {
  cancelEmailSyncRun,
  deleteEmailSyncWorkflow,
  EMAIL_SYNC_CHANGED_EVENT,
  listEmailSyncRuns,
  listEmailSyncWorkflows,
  retryEmailSyncRun,
  startEmailSyncRun,
  updateEmailSyncWorkflow,
  type EmailSyncRun,
  type EmailSyncWorkflow,
} from './api'

const activeStatuses = new Set<EmailSyncRun['status']>(['queued', 'scanning', 'running', 'canceling'])

export function EmailSyncWorkflowPage({ workflowId }: { workflowId: string }) {
  const confirm = useConfirm()
  const [workflow, setWorkflow] = useState<EmailSyncWorkflow | null>(null)
  const [runs, setRuns] = useState<EmailSyncRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [activePanel, setActivePanel] = useState<'trigger' | 'action' | 'runs' | null>(null)
  const completedRunRef = useRef('')
  const destinationTables = useEmailSyncTableOptions(workflow?.target.table_path || '')

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const [workflows, nextRuns] = await Promise.all([
        listEmailSyncWorkflows(),
        listEmailSyncRuns(workflowId, 20),
      ])
      setWorkflow(workflows.find((item) => item.id === workflowId) || null)
      setRuns(nextRuns)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load email sync workflow')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    void load(true)
    const handleChanged = () => { void load(false) }
    window.addEventListener(EMAIL_SYNC_CHANGED_EVENT, handleChanged)
    return () => window.removeEventListener(EMAIL_SYNC_CHANGED_EVENT, handleChanged)
  }, [load])

  const latestRun = runs[0] || null
  const activeRun = latestRun && activeStatuses.has(latestRun.status) ? latestRun : null
  const destinationTable = workflow
    ? destinationTables.options.find((table) => table.id === workflow.target.table_id)
      || (!workflow.target.table_id ? destinationTables.options[0] : null)
    : null

  useEffect(() => {
    if (!activeRun) return
    const timer = window.setInterval(() => { void load(false) }, 1000)
    return () => window.clearInterval(timer)
  }, [activeRun, load])

  useEffect(() => {
    if (!latestRun || latestRun.status !== 'completed' || completedRunRef.current === latestRun.id) return
    completedRunRef.current = latestRun.id
    window.dispatchEvent(new CustomEvent('kition:workspace-reload', {
      detail: { preferredPath: latestRun.table_path, treeOnly: true },
    }))
  }, [latestRun])

  async function start(mode: 'incremental' | 'full') {
    if (!workflow) return
    setBusy(mode)
    setError('')
    try {
      await startEmailSyncRun(workflow.id, mode)
      await load(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to start email sync')
    } finally {
      setBusy('')
    }
  }

  async function saveSchedule(enabled: boolean, intervalMinutes = workflow?.schedule.interval_minutes || 15) {
    if (!workflow) return
    setBusy('schedule')
    setError('')
    try {
      await updateEmailSyncWorkflow(workflow.id, {
        schedule: { enabled, interval_minutes: intervalMinutes },
      })
      await load(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to update workflow')
    } finally {
      setBusy('')
    }
  }

  async function cancel() {
    if (!activeRun) return
    setBusy('cancel')
    setError('')
    try {
      await cancelEmailSyncRun(activeRun.id)
      await load(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to cancel email sync')
    } finally {
      setBusy('')
    }
  }

  async function retry(run: EmailSyncRun) {
    setBusy(`retry:${run.id}`)
    setError('')
    try {
      await retryEmailSyncRun(run.id)
      await load(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to retry email sync')
    } finally {
      setBusy('')
    }
  }

  async function removeWorkflow() {
    if (!workflow) return
    if (!(await confirm({
      message: `Delete ${workflow.name}? Imported tables and Markdown documents will remain in the workspace.`,
      variant: 'destructive',
    }))) return
    setBusy('delete')
    setError('')
    try {
      const tablePath = workflow.target.table_path
      await deleteEmailSyncWorkflow(workflow.id)
      window.dispatchEvent(new CustomEvent('kition:onboarding:open-local-workflow', {
        detail: { kitablePath: tablePath },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to delete workflow')
      setBusy('')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background" role="status">
        <LoaderCircle className="size-5 animate-spin text-primary" />
      </div>
    )
  }

  if (!workflow) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6 text-sm text-muted-foreground">
        Email sync workflow not found.
      </div>
    )
  }

  const provider = getEmailProvider(resolveEmailProviderId('imap', workflow.connection.host, workflow.connection.username))
  const actionFailing = latestRun?.status === 'failed' || workflow.status === 'error'
  const discovered = activeRun?.discovered_messages || 0
  const processed = activeRun?.processed_messages || 0
  const progress = discovered > 0 ? Math.min(100, Math.round((processed / discovered) * 100)) : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background pt-12" data-testid="email-sync-workflow-page">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Mail className="size-4 text-primary" />
          <h1 className="truncate text-base font-semibold text-foreground">{workflow.name}</h1>
          <button
            type="button"
            role="switch"
            aria-checked={workflow.schedule.enabled}
            aria-label="Enable email sync schedule"
            disabled={busy === 'schedule' || Boolean(activeRun)}
            onClick={() => void saveSchedule(!workflow.schedule.enabled)}
            className={`relative h-5 w-9 rounded-full border transition-colors ${workflow.schedule.enabled ? 'border-primary bg-primary' : 'border-border bg-muted'} disabled:opacity-50`}
          >
            <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform ${workflow.schedule.enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setActivePanel('runs')}>
            <Clock3 className="size-4" />
            Run history
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive hover:text-destructive"
            disabled={Boolean(activeRun || busy)}
            onClick={() => void removeWorkflow()}
            aria-label="Delete email sync workflow"
          >
            {busy === 'delete' ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          </Button>
          <Button variant="outline" size="sm" disabled={Boolean(activeRun || busy)} onClick={() => void start('incremental')}>
            {busy === 'incremental' ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Sync now
          </Button>
          <Button size="sm" disabled={Boolean(activeRun || busy)} onClick={() => void start('full')} data-testid="email-sync-workflow-sync-all">
            {busy === 'full' ? <LoaderCircle className="size-4 animate-spin" /> : <ListRestart className="size-4" />}
            Sync all
          </Button>
        </div>
      </header>

      {error ? (
        <CopyableEmailSyncError message={error} className="mx-6 mt-4 shrink-0 px-4 py-3" testId="email-sync-page-error" />
      ) : null}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 p-4">
          <WorkflowCanvas key={activePanel ? 'drawer-open' : 'drawer-closed'} disabled>
            <NodeCard
              kind="trigger"
              rowLabel="Step 1 · Trigger"
              title={workflow.schedule.enabled ? 'Scheduled trigger' : 'Manual trigger'}
              description={workflow.schedule.enabled
                ? `Every ${workflow.schedule.interval_minutes} minutes`
                : 'Run from Sync now or Sync all'}
              status={workflow.schedule.enabled ? 'green' : 'muted'}
              selected={activePanel === 'trigger'}
              dataRole="trigger"
              onSelect={() => setActivePanel('trigger')}
            />
            <NodeCard
              kind="action"
              rowLabel="Step 2 · Email"
              title="Sync email inbox"
              description={`${provider.label} · ${workflow.connection.mailbox} → ${destinationTable?.title || tableName(workflow.target.table_path)}`}
              status={actionFailing ? 'red' : activeRun ? 'amber' : 'green'}
              selected={activePanel === 'action'}
              dataRole="action"
              onSelect={() => setActivePanel('action')}
              inlineError={workflow.last_error ? { message: workflow.last_error, onFix: () => setActivePanel('action') } : null}
              extra={activeRun ? (
                <div className="mt-2 min-w-0">
                  <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span className="truncate">
                      {activeRun.status === 'scanning'
                        ? 'Scanning mailbox'
                        : `${activeRun.mode === 'full' ? 'Syncing all email' : 'Syncing new email'} · ${processed}${discovered ? ` of ${discovered}` : ''} processed`}
                    </span>
                    <span>{progress === null ? 'Running' : `${progress}%`}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full bg-primary ${progress === null ? 'w-1/3 animate-pulse' : ''}`} style={progress === null ? undefined : { width: `${progress}%` }} />
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">{workflow.synced_messages} messages synced</div>
              )}
            />
          </WorkflowCanvas>
        </main>

        <PropertiesDrawer
          open={activePanel !== null}
          kind={activePanel === 'trigger' ? 'Trigger' : 'Action'}
          title={activePanel === 'trigger'
            ? 'Start this workflow'
            : activePanel === 'runs'
              ? 'Run history'
              : 'Sync email inbox'}
          onClose={() => setActivePanel(null)}
        >
          <div data-testid="email-sync-workflow-drawer">
            {activePanel === 'action' ? (
              <EmailSyncWorkflowEditor
                layout="panel"
                showSchedule={false}
                tablePath={workflow.target.table_path}
                workflow={workflow}
                onCancel={() => setActivePanel(null)}
                onSaved={(saved) => {
                  setWorkflow(saved)
                  setActivePanel(null)
                  void load(false)
                }}
              />
            ) : activePanel === 'trigger' ? (
              <EmailSyncTriggerPanel
                enabled={workflow.schedule.enabled}
                intervalMinutes={workflow.schedule.interval_minutes}
                busy={busy === 'schedule'}
                onSave={(enabled, intervalMinutes) => void saveSchedule(enabled, intervalMinutes)}
              />
            ) : (
              <div className="grid gap-4">
                <CurrentRunPanel run={latestRun} onCancel={cancel} canceling={busy === 'cancel'} />
                <RunHistory runs={runs} busy={busy} onRetry={retry} />
              </div>
            )}
          </div>
        </PropertiesDrawer>
      </div>
    </div>
  )
}

function CurrentRunPanel({ run, onCancel, canceling }: { run: EmailSyncRun | null; onCancel: () => void; canceling: boolean }) {
  if (!run) {
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-5 shadow-sm">
        <div className="text-sm font-semibold text-foreground">Ready to sync</div>
        <p className="mt-1 text-sm text-muted-foreground">Run this workflow to import email records and Markdown content.</p>
      </section>
    )
  }

  const active = activeStatuses.has(run.status)
  const discovered = run.discovered_messages
  const percentage = discovered > 0 ? Math.min(100, Math.round((run.processed_messages / discovered) * 100)) : null
  const title = run.status === 'queued'
    ? 'Waiting to start'
    : run.status === 'scanning'
      ? 'Scanning mailbox'
      : run.status === 'running'
        ? run.mode === 'full' ? 'Syncing all email' : 'Syncing new email'
        : run.status === 'canceling'
          ? 'Canceling sync'
          : run.status === 'completed'
            ? 'Sync completed'
            : run.status === 'failed'
              ? 'Sync failed'
              : run.status === 'canceled'
                ? 'Sync canceled'
                : 'Sync interrupted'

  return (
    <section className={`rounded-xl border px-5 py-5 shadow-sm ${run.status === 'failed' ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-card'}`} data-testid="email-sync-current-run">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <RunStatusIcon status={run.status} />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.processed_messages}{discovered ? ` of ${discovered}` : ''} processed · Batch {Math.max(1, run.current_batch)}
            </p>
          </div>
        </div>
        {active ? (
          <Button variant="outline" size="sm" disabled={canceling || run.status === 'canceling'} onClick={onCancel}>
            <XCircle className="size-4" />
            Cancel
          </Button>
        ) : null}
      </div>
      {active ? (
        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full bg-primary transition-[width] ${percentage === null ? 'w-1/3 animate-pulse' : ''}`}
              style={percentage === null ? undefined : { width: `${percentage}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Imported" value={run.imported} />
        <Metric label="Updated" value={run.updated} />
        <Metric label="Skipped" value={run.skipped} />
        <Metric label="Failed" value={run.failed} danger={run.failed > 0} />
      </div>
      {run.error ? <CopyableEmailSyncError message={run.error} className="mt-4" testId="email-sync-run-error" /> : null}
    </section>
  )
}

function RunHistory({ runs, busy, onRetry }: { runs: EmailSyncRun[]; busy: string; onRetry: (run: EmailSyncRun) => void }) {
  if (!runs.length) {
    return <div className="border-y border-border px-4 py-8 text-center text-sm text-muted-foreground">No runs yet.</div>
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {runs.map((run) => (
        <div key={run.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex min-w-0 items-center gap-3">
            <RunStatusIcon status={run.status} compact />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span className="capitalize">{run.mode}</span>
                <span className="text-muted-foreground">·</span>
                <span className="capitalize text-muted-foreground">{run.status}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                Imported {run.imported} · Updated {run.updated} · Skipped {run.skipped} · Failed {run.failed} · {formatTime(run.started_at || run.created_at)}
              </div>
            </div>
          </div>
          {['failed', 'canceled', 'interrupted'].includes(run.status) ? (
            <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => onRetry(run)}>
              {busy === `retry:${run.id}` ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              Retry
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function RunStatusIcon({ status, compact = false }: { status: EmailSyncRun['status']; compact?: boolean }) {
  const size = compact ? 'size-4' : 'size-5'
  if (activeStatuses.has(status)) return <LoaderCircle className={`${size} shrink-0 animate-spin text-primary`} />
  if (status === 'completed') return <CheckCircle2 className={`${size} shrink-0 text-success`} />
  if (status === 'failed') return <AlertCircle className={`${size} shrink-0 text-destructive`} />
  return <XCircle className={`${size} shrink-0 text-muted-foreground`} />
}

function Metric({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className={`text-base font-semibold ${danger ? 'text-destructive' : 'text-foreground'}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function tableName(path: string) {
  return path.split(/[\\/]/).pop()?.replace(/\.kitable$/i, '') || 'Email'
}

function formatTime(value?: string) {
  if (!value) return 'Not started'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
