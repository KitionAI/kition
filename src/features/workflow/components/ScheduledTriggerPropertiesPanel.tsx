import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { previewSchedule } from '../api'
import { DrawerField, DrawerSection } from '../drawer/PropertiesDrawer'

/**
 * ScheduledTriggerPropertiesPanel edits the cron expression behind a
 * scheduled_time trigger. We expose a simple "Frequency + Time of day"
 * UI (mirroring Feishu Base's pickers) and synthesise a standard 5-field
 * cron string from the choices, plus an advanced text field for the
 * power-user case (cron strings the picker can't express, e.g. "every
 * 15 minutes" or "weekdays only").
 *
 * Timezone: the cron is anchored to an IANA timezone (e.g.
 * "America/New_York"). Empty timezone means "server local time" — the
 * same legacy default as before this field existed. Users in different
 * timezones picking "0 9 * * *" would otherwise silently disagree on
 * when 9am is, so we default new schedules to the browser's TZ via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` at create time
 * (callers do the defaulting; the panel just renders the current value).
 *
 * The panel is fully controlled — the parent owns the cron string and
 * timezone in its draft state and calls
 * `patchWorkflow({ trigger: { schedule: { cron, timezone } } })` on save.
 * We never round-trip through the parser to "normalise" the user's
 * expression because robfig/cron tolerates many shapes the picker can't,
 * and silently rewriting them would surprise.
 *
 * Validation: the backend enforces cron syntax via validate.go's
 * cronValidator and IANA TZ names via time.LoadLocation. The UI surfaces
 * hints pointing the user at the offending field; we deliberately don't
 * reparse the expression client-side (no dependency, no drift risk).
 */
export interface ScheduledTriggerPropertiesPanelProps {
  cron: string
  /** IANA timezone name, e.g. "America/New_York". Empty/undefined = use
   *  the server's local time (legacy behavior). */
  timezone?: string
  onChange: (next: { cron: string; timezone: string }) => void
  /** Surface server-side validation errors next to the cron field — the
   *  parent passes the NodeIssue.Hint string from `trigger_schedule_invalid`
   *  diagnostics when they exist. */
  error?: string
  /** Surface server-side validation errors for the timezone field. */
  timezoneError?: string
  /** Disables the inputs during a save / cross-network call. */
  disabled?: boolean
}

const FREQUENCY_VALUES: ScheduledFrequency[] = ['daily', 'weekdays', 'weekly_monday', 'hourly', 'custom']

type ScheduledFrequency = 'daily' | 'weekdays' | 'weekly_monday' | 'hourly' | 'custom'

interface ParsedCron {
  frequency: ScheduledFrequency
  /** HH:MM in 24h notation. Empty for hourly/custom — those don't have a
   *  single time-of-day. */
  timeOfDay: string
}

export function ScheduledTriggerPropertiesPanel({
  cron,
  timezone,
  onChange,
  error,
  timezoneError,
  disabled,
}: ScheduledTriggerPropertiesPanelProps) {
  const { t } = useTranslation('workflow')
  const parsed = useMemo(() => parseCron(cron), [cron])
  const browserTZ = useMemo(() => detectBrowserTimezone(), [])
  // Show the user the *resolved* TZ — empty stored value falls back to the
  // server's local timezone at fire time, but we don't know what that is,
  // so we surface the browser's TZ as the best client-side approximation
  // and label it so the user understands the difference.
  const effectiveTZ = timezone || browserTZ
  const preview = useSchedulePreview(cron, timezone || '', !!error)

  function emit(next: ParsedCron) {
    if (next.frequency === 'custom') {
      // Custom mode: don't touch the existing cron string — the user is
      // typing it directly. Only the text-field onChange edits it.
      return
    }
    onChange({ cron: buildCron(next), timezone: timezone || '' })
  }

  return (
    <DrawerSection title={t('panels.schedule.section')}>
      <DrawerField label={t('panels.schedule.frequencyLabel')}>
        <select
          data-testid="scheduled-trigger-frequency"
          value={parsed.frequency}
          disabled={disabled}
          onChange={(event) => {
            const nextFreq = event.target.value as ScheduledFrequency
            if (nextFreq === 'custom') {
              // Switching INTO custom: leave the current cron alone so the
              // user sees what they had and can edit from there.
              return
            }
            emit({ ...parsed, frequency: nextFreq })
          }}
          className={INPUT_CLASS}
        >
          {FREQUENCY_VALUES.map((value) => (
            <option key={value} value={value}>{t(`panels.schedule.frequencyOptions.${value}`)}</option>
          ))}
        </select>
      </DrawerField>

      {parsed.frequency === 'custom' || parsed.frequency === 'hourly' ? null : (
        <DrawerField label={t('panels.schedule.timeOfDayLabel')} hint={t('panels.schedule.timeOfDayHint', { tz: effectiveTZ })}>
          <input
            type="time"
            data-testid="scheduled-trigger-time"
            value={parsed.timeOfDay || '09:00'}
            disabled={disabled}
            onChange={(event) => {
              emit({ ...parsed, timeOfDay: event.target.value })
            }}
            className={INPUT_CLASS}
          />
        </DrawerField>
      )}

      <DrawerField
        label={t('panels.schedule.timezoneLabel')}
        hint={timezone ? undefined : t('panels.schedule.timezoneHint', { tz: browserTZ })}
        error={timezoneError}
      >
        <input
          type="text"
          data-testid="scheduled-trigger-timezone"
          list="scheduled-trigger-timezone-list"
          value={timezone || ''}
          placeholder={browserTZ}
          disabled={disabled}
          onChange={(event) => onChange({ cron, timezone: event.target.value.trim() })}
          className={`${INPUT_CLASS} font-mono`}
          spellCheck={false}
        />
        <datalist id="scheduled-trigger-timezone-list">
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      </DrawerField>

      <DrawerField
        label={t('panels.schedule.cronLabel')}
        hint={parsed.frequency === 'custom' ? t('panels.schedule.cronHintCustom') : t('panels.schedule.cronHintPreview')}
        error={error}
      >
        <input
          type="text"
          data-testid="scheduled-trigger-cron"
          value={cron}
          disabled={disabled || parsed.frequency !== 'custom'}
          placeholder="0 9 * * *"
          onChange={(event) => onChange({ cron: event.target.value, timezone: timezone || '' })}
          className={`${INPUT_CLASS} font-mono`}
          spellCheck={false}
        />
      </DrawerField>

      <div
        data-testid="scheduled-trigger-next-run"
        data-state={preview.state}
        className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground"
      >
        {preview.state === 'idle' ? (
          <span className="text-muted-foreground">{t('panels.schedule.previewIdle')}</span>
        ) : preview.state === 'loading' ? (
          <span className="text-muted-foreground">{t('panels.schedule.previewLoading')}</span>
        ) : preview.state === 'error' ? (
          <span className="text-destructive">{t('panels.schedule.previewError')}</span>
        ) : (
          <span>
            <strong className="font-semibold text-foreground">{t('panels.schedule.previewNextRun')}</strong>{' '}
            {formatPreviewTime(preview.runs[0], effectiveTZ)}
            {preview.runs.length > 1 ? (
              <span className="ml-2 text-muted-foreground">
                ({t('panels.schedule.previewThenPrefix')}{preview.runs.slice(1).map((iso) => formatPreviewTime(iso, effectiveTZ, true)).join(', ')})
              </span>
            ) : null}
          </span>
        )}
      </div>
    </DrawerSection>
  )
}

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground'

/** parseCron maps a 5-field cron expression to one of the picker presets. We
 *  match exact shapes only — anything we don't recognise falls back to
 *  `custom`, which gates the text input. */
export function parseCron(cron: string): ParsedCron {
  const trimmed = (cron || '').trim()
  if (!trimmed) {
    // Empty cron → default to "every day at 09:00" so the user sees
    // sensible defaults the moment they pick the scheduled_time trigger.
    return { frequency: 'daily', timeOfDay: '09:00' }
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return { frequency: 'custom', timeOfDay: '' }
  const [minute, hour, dom, month, dow] = parts

  // Hourly preset: "0 * * * *" — fire at minute 0 every hour.
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { frequency: 'hourly', timeOfDay: '' }
  }

  // Time-of-day shaped presets require integer minute + hour.
  const minNum = Number.parseInt(minute, 10)
  const hourNum = Number.parseInt(hour, 10)
  const minuteIsConst = !Number.isNaN(minNum) && String(minNum) === minute
  const hourIsConst = !Number.isNaN(hourNum) && String(hourNum) === hour
  if (!minuteIsConst || !hourIsConst) return { frequency: 'custom', timeOfDay: '' }
  if (month !== '*') return { frequency: 'custom', timeOfDay: '' }

  const tod = `${pad2(hourNum)}:${pad2(minNum)}`

  // Daily: "M H * * *"
  if (dom === '*' && dow === '*') {
    return { frequency: 'daily', timeOfDay: tod }
  }
  // Weekdays: "M H * * 1-5"
  if (dom === '*' && dow === '1-5') {
    return { frequency: 'weekdays', timeOfDay: tod }
  }
  // Weekly Monday: "M H * * 1"
  if (dom === '*' && dow === '1') {
    return { frequency: 'weekly_monday', timeOfDay: tod }
  }
  return { frequency: 'custom', timeOfDay: '' }
}

/** buildCron synthesises a cron expression from picker presets. Inverse of
 *  parseCron for the preset cases; `custom` short-circuits before reaching
 *  here so we never overwrite a user-edited expression. */
export function buildCron({ frequency, timeOfDay }: ParsedCron): string {
  if (frequency === 'hourly') return '0 * * * *'
  const { hour, minute } = splitTime(timeOfDay || '09:00')
  switch (frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly_monday':
      return `${minute} ${hour} * * 1`
    case 'custom':
      // Defensive — callers gate on this before invoking buildCron.
      return ''
  }
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function splitTime(hhmm: string): { hour: string; minute: string } {
  const [hh, mm] = hhmm.split(':')
  const hour = Number.parseInt(hh ?? '', 10)
  const minute = Number.parseInt(mm ?? '', 10)
  return {
    hour: Number.isNaN(hour) ? '9' : String(hour),
    minute: Number.isNaN(minute) ? '0' : String(minute),
  }
}

/** detectBrowserTimezone returns the IANA name the browser thinks the user
 *  is in. Falls back to "UTC" when Intl is unavailable (older test runtimes,
 *  rare). Pure function so the test can call it directly without a DOM. */
export function detectBrowserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** SchedulePreviewState mirrors the small state machine the preview row
 *  drives: idle (no input yet or cron is empty), loading (fetch inflight),
 *  ready (server returned at least one next-run), error (server rejected
 *  the cron/tz or the network failed). */
type SchedulePreviewState =
  | { state: 'idle'; runs: [] }
  | { state: 'loading'; runs: [] }
  | { state: 'error'; runs: [] }
  | { state: 'ready'; runs: string[] }

const PREVIEW_DEBOUNCE_MS = 350

/** useSchedulePreview debounces the cron+tz pair and asks the server for
 *  the next fire times. Skipped when an outer error is already visible
 *  (no point asking the server about a value the user already knows is
 *  broken) or when cron is empty (the empty-state caption explains).
 *
 *  Exported as part of the file's testable surface but currently only used
 *  by the panel itself — the unit tests stub previewSchedule via vi.mock. */
function useSchedulePreview(cron: string, timezone: string, hasOuterError: boolean): SchedulePreviewState {
  const [result, setResult] = useState<SchedulePreviewState>({ state: 'idle', runs: [] })
  useEffect(() => {
    const trimmed = cron.trim()
    if (!trimmed || hasOuterError) {
      setResult({ state: 'idle', runs: [] })
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      setResult({ state: 'loading', runs: [] })
      previewSchedule(trimmed, timezone)
        .then((resp) => {
          if (cancelled) return
          if (!resp.nextRuns || resp.nextRuns.length === 0) {
            setResult({ state: 'error', runs: [] })
            return
          }
          setResult({ state: 'ready', runs: resp.nextRuns })
        })
        .catch(() => {
          if (cancelled) return
          setResult({ state: 'error', runs: [] })
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [cron, timezone, hasOuterError])
  return result
}

/** formatPreviewTime renders an ISO8601 UTC string in the effective TZ. We
 *  use Intl directly rather than dayjs/luxon — the cost of a tiny localise
 *  is fine and we avoid pulling a date library just for this caption. The
 *  `short` variant drops the date part when it matches today/tomorrow's
 *  date and only the time differs, keeping the "then …" suffix readable. */
function formatPreviewTime(isoUTC: string, tz: string, short?: boolean): string {
  if (!isoUTC) return ''
  try {
    const d = new Date(isoUTC)
    if (Number.isNaN(d.getTime())) return isoUTC
    if (short) {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d)
    }
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return isoUTC
  }
}

/** COMMON_TIMEZONES is the curated short-list shown in the timezone picker's
 *  <datalist>. The full IANA list (~600 names) overwhelms the picker; this
 *  hits the major business hubs and keeps free-text entry for anything else.
 *  Validation lives in validate.go — anything time.LoadLocation accepts will
 *  pass server-side. */
const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]
