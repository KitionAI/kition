import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import type { ScenarioBuildEvent } from '@/features/scenario/types'
import { cn } from '@/lib/utils'

export interface BuildProgressCardProps {
  events: ScenarioBuildEvent[]
  /** Optional title shown in the card header (e.g. the inferred base name). */
  title?: string
}

type SubtaskStatus = 'pending' | 'running' | 'done'

interface SubtaskState {
  labelKey: string
  status: SubtaskStatus
}

const SUBTASK_LABEL_KEYS = [
  'buildProgress.subtasks.generateFields',
  'buildProgress.subtasks.generateAiFields',
  'buildProgress.subtasks.generateRecords',
  'buildProgress.subtasks.generateViews',
] as const

/**
 * Derive 4 subtask states from the events array.
 *
 * Done rules (from PRD §4.3):
 *   - "Generate fields"    → any `fields.generated` with stage='fields'
 *   - "Generate AI fields" → any `fields.generated` with stage='ai-fields'
 *   - "Generate records"   → any `records.generated`
 *   - "Generate views"     → any `views.generated`
 *
 * Running rule: once ANY event has been received, the first still-pending
 * subtask (in order) flips to 'running'.
 */
function deriveSubtaskStates(events: ScenarioBuildEvent[]): SubtaskState[] {
  const hasStarted = events.length > 0

  const done = [false, false, false, false]

  for (const event of events) {
    if (event.kind === 'fields.generated' && event.stage === 'fields') {
      done[0] = true
    }
    if (event.kind === 'fields.generated' && event.stage === 'ai-fields') {
      done[1] = true
    }
    if (event.kind === 'records.generated') {
      done[2] = true
    }
    if (event.kind === 'views.generated') {
      done[3] = true
    }
  }

  // Find first pending index (to flip to 'running')
  const firstPendingIndex = hasStarted ? done.findIndex((d) => !d) : -1

  return SUBTASK_LABEL_KEYS.map((labelKey, index) => {
    let status: SubtaskStatus = 'pending'
    if (done[index]) {
      status = 'done'
    } else if (index === firstPendingIndex) {
      status = 'running'
    }
    return { labelKey, status }
  })
}

// Pending icon: empty circle outline
function PendingIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-muted-foreground/60"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
    </svg>
  )
}

// Done icon: checkmark
function DoneIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-green-500"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" fill="currentColor" fillOpacity={0.12} />
      <polyline points="5,8.5 7,10.5 11,6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BuildProgressCard({ events, title }: BuildProgressCardProps) {
  const { t } = useTranslation('agent')
  const subtasks = useMemo(() => deriveSubtaskStates(events), [events])

  const doneCount = subtasks.filter((s) => s.status === 'done').length
  const percent = Math.round((doneCount / 4) * 100)
  const hasRunning = subtasks.some((s) => s.status === 'running')
  const displayTitle = title ?? t('buildProgress.buildingBase')

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">{displayTitle}</span>
          {hasRunning ? (
            <LoaderCircle
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
              aria-label={t('buildProgress.buildingInProgress')}
              data-testid="progress-card-header-spinner"
            />
          ) : null}
        </div>
        <span
          className="text-xs text-muted-foreground shrink-0 tabular-nums"
          data-testid="progress-percent"
        >
          {percent}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <div
          className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('buildProgress.progressLabel', { percent })}
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Subtask rows */}
      <div className="space-y-1.5">
        {subtasks.map((subtask, index) => (
          <div
            key={subtask.labelKey}
            data-testid={`progress-row-${index}`}
            data-status={subtask.status}
            className={cn(
              'flex items-center gap-2 text-sm',
              subtask.status === 'done' && 'text-muted-foreground',
              subtask.status === 'running' && 'text-foreground font-medium',
              subtask.status === 'pending' && 'text-muted-foreground/60',
            )}
          >
            {subtask.status === 'done' ? (
              <DoneIcon />
            ) : subtask.status === 'running' ? (
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-label={t('buildProgress.stepRunning', { label: t(subtask.labelKey) })}
                data-testid="progress-step-spinner"
              />
            ) : (
              <PendingIcon />
            )}
            <span>{t(subtask.labelKey)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
