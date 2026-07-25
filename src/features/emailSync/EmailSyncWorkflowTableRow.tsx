import { ChevronRight, LoaderCircle } from 'lucide-react'

import type { EmailSyncRun, EmailSyncWorkflow } from './api'

export function EmailSyncWorkflowTableRow({
  workflow,
  latestRun,
  tablePath,
  tableTitle,
  onOpen,
}: {
  workflow: EmailSyncWorkflow
  latestRun: EmailSyncRun | null
  tablePath: string
  tableTitle?: string
  onOpen: () => void
}) {
  const runActive = Boolean(latestRun && ['queued', 'scanning', 'running', 'canceling'].includes(latestRun.status))
  const failing = latestRun?.status === 'failed' || workflow.status === 'error'
  const enabled = workflow.schedule.enabled
  const statusText = latestRun?.status === 'queued'
    ? 'Queued'
    : latestRun?.status === 'scanning'
      ? 'Scanning'
      : latestRun?.status === 'canceling'
        ? 'Canceling'
        : runActive
          ? 'Syncing'
          : failing
            ? 'Needs attention'
            : enabled
              ? 'Scheduled'
              : 'Manual'
  const statusPillClass = failing
    ? 'bg-destructive/15 text-destructive'
    : runActive
      ? 'bg-primary/10 text-primary'
      : enabled
        ? 'bg-success/15 text-success-foreground'
      : 'bg-muted text-muted-foreground'
  const dotClass = failing ? 'bg-destructive' : enabled ? 'bg-success' : 'bg-muted-foreground/60'
  const tableName = tableTitle || tablePath.split(/[\\/]/).pop()?.replace(/\.kitable$/i, '') || 'Table'
  const trigger = workflow.schedule.enabled
    ? `IMAP · Every ${workflow.schedule.interval_minutes} min`
    : 'IMAP · Manual'
  const discovered = latestRun?.discovered_messages || 0
  const progressLabel = latestRun
    ? `${latestRun.processed_messages}${discovered ? ` / ${discovered}` : ''} processed`
    : ''
  const actionLabel = runActive
    ? `${latestRun?.mode === 'full' ? 'Sync all' : 'Sync'} · ${progressLabel}`
    : latestRun?.status === 'completed'
      ? `Imported ${latestRun.imported} · Skipped ${latestRun.skipped}`
      : 'Import email messages'

  return (
    <tr
      data-testid="email-sync-workflow-row"
      data-workflow-id={workflow.id}
      data-workflow-kind="email-sync"
      className={`cursor-pointer border-b border-border/60 hover:bg-muted/40 ${failing ? 'border-l-[3px] border-l-destructive' : ''}`}
      onClick={onOpen}
    >
      <td className="px-4 py-2.5 align-middle">
        <div className="flex items-center gap-2">
          {runActive
            ? <LoaderCircle className="size-3.5 animate-spin text-primary" />
            : <span className={`inline-block h-[7px] w-[7px] rounded-full ${dotClass}`} />}
          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusPillClass}`}>{statusText}</span>
        </div>
      </td>
      <td className="px-4 py-2.5 align-middle">
        <div className="max-w-[220px] truncate text-sm font-medium text-foreground">{workflow.name}</div>
      </td>
      <td className="px-4 py-2.5 align-middle text-sm text-muted-foreground">{trigger}</td>
      <td className="max-w-[260px] px-4 py-2.5 align-middle text-sm text-muted-foreground">
        <div className="truncate">{actionLabel}</div>
        {runActive && discovered > 0 ? (
          <div className="mt-1 h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.min(100, ((latestRun?.processed_messages || 0) / discovered) * 100)}%` }}
            />
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2.5 align-middle text-sm text-muted-foreground">{tableName}</td>
      <td className="whitespace-nowrap px-4 py-2.5 align-middle text-sm text-muted-foreground/80">
        {runActive ? 'Running now' : latestRun?.finished_at ? formatDate(latestRun.finished_at) : workflow.last_sync_at ? formatDate(workflow.last_sync_at) : '—'}
      </td>
      <td className="px-4 py-2.5 text-right align-middle">
        <button
          type="button"
          className="inline-grid size-8 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:bg-muted/40"
          title="Open email sync workflow"
          aria-label="Open email sync workflow"
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          <ChevronRight className="size-4" />
        </button>
      </td>
    </tr>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
