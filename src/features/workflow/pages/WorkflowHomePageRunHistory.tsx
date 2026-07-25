import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'

/**
 * Run-history rendering primitives split out of WorkflowHomePage (WF-C1c).
 *
 * InlineRunHistory + RunHistoryRow + RunFilterChip + LogsView all hang off
 * the same WorkflowRunRecord shape and share the time-formatting helpers,
 * so they live together. The shared helpers (relativeTime,
 * formatAbsoluteTime) used to be private to WorkflowHomePage; making them
 * module-private here keeps the public surface tight while still letting
 * LogsView reuse formatAbsoluteTime without copy-paste drift.
 *
 * No state, no effects — every component below is a pure render. State
 * (status filter, expandedRunId, retryInFlight) stays on the page.
 */

export function InlineRunHistory({
  status,
  runs,
  counts,
  statusFilter,
  onStatusFilter,
  onRetry,
  retryInFlight,
  error,
  expandedRunId,
  onToggle,
  onJumpToNode,
}: {
  status: string
  runs: WorkflowRunRecord[]
  counts: { all: number; ok: number; error: number; skipped: number }
  statusFilter: 'all' | 'ok' | 'error' | 'skipped'
  onStatusFilter: (next: 'all' | 'ok' | 'error' | 'skipped') => void
  onRetry: (runId: string) => void | Promise<void>
  retryInFlight: string | null
  error: string | null
  expandedRunId: string | null
  onToggle: (id: string) => void
  onJumpToNode: (nodeId: string) => void
}) {
  const { t } = useTranslation('workflow')
  return (
    <section data-testid="run-history-panel" className="grid gap-2">
      <div className="flex flex-wrap gap-1.5" data-testid="run-history-filter-chips">
        <RunFilterChip active={statusFilter === 'all'} onClick={() => onStatusFilter('all')} testId="runs-filter-chip-all">
          {t('runs.filters.all')} <span className="text-[10px] text-muted-foreground/80">{counts.all}</span>
        </RunFilterChip>
        <RunFilterChip active={statusFilter === 'ok'} onClick={() => onStatusFilter('ok')} testId="runs-filter-chip-sent">
          {t('runs.filters.sent')} <span className="text-[10px] text-muted-foreground/80">{counts.ok}</span>
        </RunFilterChip>
        <RunFilterChip active={statusFilter === 'error'} onClick={() => onStatusFilter('error')} testId="runs-filter-chip-failed" tone="error">
          {t('runs.filters.failed')} <span className="text-[10px] text-destructive">{counts.error}</span>
        </RunFilterChip>
        <RunFilterChip active={statusFilter === 'skipped'} onClick={() => onStatusFilter('skipped')} testId="runs-filter-chip-skipped">
          {t('runs.filters.skipped')} <span className="text-[10px] text-muted-foreground/80">{counts.skipped}</span>
        </RunFilterChip>
      </div>
      {status === 'loading' && runs.length === 0 ? <div className="text-sm text-muted-foreground">{t('runs.loading')}</div> : null}
      {status === 'error' ? <div className="text-sm text-destructive">✕ {error}</div> : null}
      {runs.length === 0 && status !== 'loading' && status !== 'error' ? <div className="text-sm text-muted-foreground">{t('runs.empty')}</div> : null}
      {runs.map((run, index) => (
        <RunHistoryRow
          key={run.id}
          run={run}
          index={index}
          expanded={expandedRunId === run.id}
          onToggle={() => onToggle(run.id)}
          onJumpToNode={onJumpToNode}
          onRetry={onRetry}
          retryInFlight={retryInFlight === run.id}
        />
      ))}
      <div className="mt-2 text-center text-[11px] text-muted-foreground/80" data-testid="run-history-prune-hint">
        {t('runs.pruneHint')}
      </div>
    </section>
  )
}

function RunFilterChip({
  active,
  tone,
  testId,
  onClick,
  children,
}: {
  active: boolean
  tone?: 'error'
  testId?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
        active
          ? tone === 'error'
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : 'border-primary/30 bg-primary/15 text-primary'
          : 'border-border bg-card text-muted-foreground hover:bg-muted/40'
      }`}
    >
      {children}
    </button>
  )
}

function RunHistoryRow({
  run,
  index,
  expanded,
  onToggle,
  onJumpToNode,
  onRetry,
  retryInFlight,
}: {
  run: WorkflowRunRecord
  index: number
  expanded: boolean
  onToggle: () => void
  onJumpToNode: (nodeId: string) => void
  onRetry: (runId: string) => void | Promise<void>
  retryInFlight: boolean
}) {
  const { t } = useTranslation('workflow')
  const relStrings = useMemo<RelativeTimeStrings>(() => ({
    justNow: t('runs.time.justNow'),
    minutesAgo: (n) => t('runs.time.minutesAgo', { n }),
    hoursAgo: (n) => t('runs.time.hoursAgo', { n }),
    daysAgo: (n) => t('runs.time.daysAgo', { n }),
  }), [t])
  const ok = run.status === 'ok'
  const skipped = run.status === 'skipped'
  const failed = run.status === 'error'
  const ts = run.finishedAt || run.startedAt
  const label = ok ? t('runs.rowLabel.sent') : skipped ? t('runs.rowLabel.skipped') : t('runs.rowLabel.failed')
  const labelClass = ok ? 'text-success-foreground' : skipped ? 'text-muted-foreground' : 'text-destructive'
  const showRetry = failed || skipped
  return (
    <div
      data-testid={`run-row-${index}`}
      data-run-id={run.id}
      data-status={run.status}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      aria-expanded={expanded}
      className="w-full rounded-xl border border-border bg-card p-3 text-left text-foreground hover:border-hairline-strong focus:outline-none focus:ring-2 focus:ring-primary/30"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${labelClass}`}>{label}</span>
        <span className="text-[11px] text-muted-foreground" title={formatAbsoluteTime(ts)} data-testid="run-history-time">{relativeTime(ts, relStrings)}</span>
        {showRetry ? (
          <button
            type="button"
            data-testid={`run-row-${index}-retry`}
            disabled={retryInFlight}
            onClick={(event) => {
              event.stopPropagation()
              void onRetry(run.id)
            }}
            className="rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
          >
            {retryInFlight ? '…' : t('runs.retry')}
          </button>
        ) : null}
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{run.to}</div>
      <div className="truncate text-xs text-muted-foreground">{run.subject}</div>
      {!ok && run.failingNodeId ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground/80">{t('runs.failedAt')}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/15"
            data-testid="run-history-jump-to-node"
            onClick={(event) => {
              event.stopPropagation()
              onJumpToNode(run.failingNodeId!)
            }}
          >
            {t('runs.viewNode', { nodeId: run.failingNodeId })}
          </button>
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-2.5 cursor-text border-t border-border pt-2 text-xs leading-relaxed">
          <div><strong>{t('runs.detailRecord')}</strong>&nbsp;&nbsp;{run.recordId}</div>
          <div><strong>{t('runs.detailWhen')}</strong>&nbsp;&nbsp;{formatAbsoluteTime(ts)}</div>
          {run.error ? <div className="text-destructive"><strong>{t('runs.detailError')}</strong>&nbsp;&nbsp;{run.error}</div> : null}
          <div className="mt-1.5 whitespace-pre-wrap"><strong>{t('runs.detailBody')}</strong>&nbsp;&nbsp;{run.body}</div>
        </div>
      ) : null}
    </div>
  )
}

export function LogsView({ status, runs, error }: { status: string; runs: WorkflowRunRecord[]; error: string | null }) {
  const { t } = useTranslation('workflow')
  return (
    <section data-testid="workflow-home-logs-tab" className="rounded-xl border border-border bg-card p-4">
      {status === 'loading' && runs.length === 0 ? <div className="text-sm text-muted-foreground">{t('runs.loadingLogs')}</div> : null}
      {status === 'error' ? <div className="text-sm text-destructive">✕ {error}</div> : null}
      <div className="grid gap-2">
        {runs.map((run) => (
          <div key={run.id} className="rounded-lg border border-border px-3 py-2 text-xs">
            <div className="font-medium">{run.triggerEvent}</div>
            <div className="mt-1 text-muted-foreground">{formatAbsoluteTime(run.finishedAt || run.startedAt)} · {run.status}</div>
            {run.error ? <div className="mt-1 text-destructive">{run.error}</div> : null}
          </div>
        ))}
        {runs.length === 0 && status !== 'loading' && status !== 'error' ? <div className="text-sm text-muted-foreground">{t('runs.emptyLogs')}</div> : null}
      </div>
    </section>
  )
}

/** RelativeTimeStrings lets a caller swap in localised time-unit strings
 *  without forking relativeTime. Pass `undefined` (or omit) to keep the
 *  English defaults — the helper's own spec relies on that path. */
export interface RelativeTimeStrings {
  justNow: string
  minutesAgo: (n: number) => string
  hoursAgo: (n: number) => string
  daysAgo: (n: number) => string
}

const DEFAULT_RELATIVE_STRINGS: RelativeTimeStrings = {
  justNow: 'just now',
  minutesAgo: (n) => `${n}m ago`,
  hoursAgo: (n) => `${n}h ago`,
  daysAgo: (n) => `${n}d ago`,
}

/** relativeTime humanises an ISO timestamp into "5m ago", "3h ago",
 *  "2d ago", or a date for older runs. Used by the row's headline; the
 *  full datetime stays in the row's title attribute via formatAbsoluteTime
 *  so hovering surfaces the exact moment.
 *
 *  Exported only for the spec — keep the relative-time contract pinned so
 *  a future change (e.g. dropping "just now") is intentional. */
export function relativeTime(raw: string, strings: RelativeTimeStrings = DEFAULT_RELATIVE_STRINGS): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const diff = Date.now() - d.getTime()
  if (diff < 0) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return strings.justNow
  if (minutes < 60) return strings.minutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return strings.hoursAgo(hours)
  const days = Math.floor(hours / 24)
  if (days < 7) return strings.daysAgo(days)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** formatAbsoluteTime renders the full datetime in the user's locale. Used
 *  as the row's hover title and in the LogsView; relative time is reserved
 *  for the visible label. Exported only for the spec. */
export function formatAbsoluteTime(raw: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
