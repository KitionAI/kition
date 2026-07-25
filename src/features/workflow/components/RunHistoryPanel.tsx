import { History as HistoryIcon, Pause, Play, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useWorkflowRuns, type WorkflowRunRecord } from '../hooks/useWorkflowRuns'

/** Initial visible row count. The hook fetches up to 50 from the server;
 *  rendering all of them on first paint is wasteful when the user only
 *  scans the top few. "Load more" reveals the rest in PAGE_SIZE
 *  increments. */
const INITIAL_PAGE_SIZE = 20
const PAGE_INCREMENT = 20

export interface RunHistoryPanelProps {
  workflowId: string
  onClose: () => void
}

/**
 * Floating right-aligned panel that lists recent runs for an workflow.
 *
 * UX fixes applied here:
 *   - Esc / backdrop click close the panel (was Tab-trap-only).
 *   - 5-second polling can be paused so a quiet workflow doesn't generate
 *     an endless background heartbeat.
 *   - Each row shows a relative timestamp ("5m ago") with the full datetime
 *     in a tooltip; older runs no longer collide with today's runs visually.
 */
export function RunHistoryPanel({ workflowId, onClose }: RunHistoryPanelProps) {
  const { t } = useTranslation('workflow')
  const [polling, setPolling] = useState(true)
  const runs = useWorkflowRuns(workflowId, polling)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState<number>(INITIAL_PAGE_SIZE)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Esc closes. Backdrop click closes. We also restore focus to whatever the
  // user had focused before the panel opened so keyboard navigation flows back
  // naturally to the canvas.
  useEffect(() => {
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused.current?.focus()
    }
  }, [onClose])

  // Reset the slice whenever the workflow swaps so the first page of the
  // new history is what the user sees. Without this, switching from a
  // workflow with 50 runs to one with 5 would still leave visibleCount
  // bumped, which is harmless but adds extra "Load more" clicks for no
  // reason on the next workflow that does have a long history.
  useEffect(() => {
    setVisibleCount(INITIAL_PAGE_SIZE)
  }, [workflowId])

  const totalRuns = runs.runs.length
  const visibleRuns = runs.runs.slice(0, visibleCount)
  const hiddenCount = Math.max(0, totalRuns - visibleCount)

  return (
    <>
      <div
        data-testid="run-history-backdrop"
        aria-hidden
        className="fixed bottom-0 left-0 right-0 top-12 z-[240] bg-black/10"
        onClick={onClose}
      />
      <div
        data-testid="run-history-panel"
        ref={panelRef}
        role="dialog"
        aria-label={t('runs.panel.panelAria')}
        tabIndex={-1}
        className="fixed right-0 top-12 z-[250] h-[calc(100%-3rem)] w-[440px] overflow-y-auto border-l border-border bg-card p-4 text-foreground shadow-[-8px_0_16px_rgba(0,0,0,0.08)] focus:outline-none"
      >
        <header className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <HistoryIcon className="size-4 text-primary" />
            {t('runs.panel.title')}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runs.refresh()}
              aria-label={t('runs.panel.refreshAria')}
              className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="run-history-refresh"
            >
              <RefreshCw className={`size-3.5 ${runs.status === 'loading' ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => setPolling((current) => !current)}
              aria-label={polling ? t('runs.panel.pauseAria') : t('runs.panel.resumeAria')}
              aria-pressed={!polling}
              data-testid="run-history-pause"
              className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title={polling ? t('runs.panel.pauseAria') : t('runs.panel.resumeAria')}
            >
              {polling ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>
            <button
              type="button"
              data-testid="run-history-close"
              onClick={onClose}
              aria-label={t('runs.panel.closeAria')}
              className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </header>
        {runs.status === 'loading' && runs.runs.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t('runs.loading')}</div>
        ) : null}
        {runs.status === 'error' ? (
          <div className="text-sm text-destructive">✕ {runs.error}</div>
        ) : null}
        {runs.runs.length === 0 && runs.status !== 'loading' && runs.status !== 'error' ? (
          <div className="text-sm text-muted-foreground">{t('runs.empty')}</div>
        ) : null}
        <div className="flex flex-col gap-2">
          {visibleRuns.map((run) => (
            <RunHistoryRow
              key={run.id}
              run={run}
              expanded={expandedId === run.id}
              onToggle={() => setExpandedId((cur) => cur === run.id ? null : run.id)}
            />
          ))}
        </div>
        {hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="run-history-load-more"
            onClick={() => setVisibleCount((cur) => cur + PAGE_INCREMENT)}
            className="mt-3 w-full rounded-md border border-border bg-card py-2 text-center text-xs font-medium text-primary hover:bg-muted/40"
          >
            {t('runs.panel.loadMore', { n: Math.min(hiddenCount, PAGE_INCREMENT), hidden: hiddenCount })}
          </button>
        ) : null}
      </div>
    </>
  )
}

function RunHistoryRow({ run, expanded, onToggle }: { run: WorkflowRunRecord; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation('workflow')
  const ok = run.status === 'ok'
  const ts = run.finishedAt || run.startedAt
  const absolute = formatAbsoluteTime(ts)
  const relStrings = useMemo(() => ({
    justNow: t('runs.time.justNow'),
    minutesAgo: (n: number) => t('runs.time.minutesAgo', { n }),
    hoursAgo: (n: number) => t('runs.time.hoursAgo', { n }),
    daysAgo: (n: number) => t('runs.time.daysAgo', { n }),
  }), [t])
  return (
    <button
      data-testid="run-history-row"
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="w-full rounded-lg border border-border bg-card p-2.5 text-left text-foreground hover:border-hairline-strong"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[13px] font-semibold ${ok ? 'text-success' : 'text-destructive'}`}>
          {ok ? t('runs.rowLabel.sent') : t('runs.rowLabel.failed')}
        </span>
        <span className="text-[11px] text-muted-foreground" title={absolute} data-testid="run-history-time">
          {formatRelativeTime(ts, relStrings)}
        </span>
      </div>
      <div className="mt-1.5 truncate text-xs text-muted-foreground">
        {run.to}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {run.subject}
      </div>
      {expanded ? (
        <div className="mt-2.5 cursor-text border-t border-border pt-2 text-xs leading-relaxed">
          <div><strong>{t('runs.detailRecord')}</strong>&nbsp;&nbsp;{run.recordId}</div>
          <div><strong>{t('runs.detailWhen')}</strong>&nbsp;&nbsp;{absolute}</div>
          {run.error ? <div className="text-destructive"><strong>{t('runs.detailError')}</strong>&nbsp;&nbsp;{run.error}</div> : null}
          <div className="mt-1.5 whitespace-pre-wrap"><strong>{t('runs.detailBody')}</strong>&nbsp;&nbsp;{run.body}</div>
        </div>
      ) : null}
    </button>
  )
}

interface RelativeStrings {
  justNow: string
  minutesAgo: (n: number) => string
  hoursAgo: (n: number) => string
  daysAgo: (n: number) => string
}

const DEFAULT_RELATIVE: RelativeStrings = {
  justNow: 'just now',
  minutesAgo: (n) => `${n}m ago`,
  hoursAgo: (n) => `${n}h ago`,
  daysAgo: (n) => `${n}d ago`,
}

function formatRelativeTime(raw: string, strings: RelativeStrings = DEFAULT_RELATIVE): string {
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

function formatAbsoluteTime(raw: string): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
