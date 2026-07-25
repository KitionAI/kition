import { ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'
import { listDataRecords } from '@/api/dataDocuments'
import type { DataRecord } from '@/types/dataDocument'

/**
 * SampleRowPicker — the UI half of WF-U3.
 *
 * Lets the user pick an existing row out of the trigger's bound table so the
 * Run-test path renders against real data instead of an LLM-generated sample.
 * Renders as a small button (e.g. "Use existing row ▾") that opens a
 * popover with the most recent N records from the bound table.
 *
 * Records are fetched lazily on first open so closed picker doesn't pay the
 * network cost — workflows with no scheduled trigger or no table binding
 * never need this affordance, and a re-render of the parent shouldn't blow
 * up the cost. Refreshing the list re-fetches on demand.
 *
 * Contract:
 *   - documentId / tableId may be 0 / "" when the trigger isn't bound yet;
 *     the button stays disabled in that state with an explanatory tooltip.
 *   - onPick is called with the picked record's values exactly as the
 *     /records endpoint returned them. The caller (Run test) forwards
 *     them to the send-test endpoint's `triggerFields` field.
 *   - The picker is uncontrolled — open/close state lives here.
 */
export interface SampleRowPickerProps {
  documentId: number | null
  tableId: number | null
  disabled?: boolean
  onPick: (values: Record<string, unknown>, record: DataRecord) => void
}

const PAGE_SIZE = 10

export function SampleRowPicker({ documentId, tableId, disabled, onPick }: SampleRowPickerProps) {
  const { t } = useTranslation('workflow')
  const [open, setOpen] = useState(false)
  const [records, setRecords] = useState<DataRecord[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const ready = Boolean(documentId && tableId)

  const refresh = useCallback(async () => {
    if (!documentId || !tableId) return
    setStatus('loading')
    setError(null)
    try {
      const resp = await listDataRecords(documentId, tableId, { limit: PAGE_SIZE })
      setRecords(resp.items ?? [])
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [documentId, tableId])

  // First open with a ready binding triggers the fetch. Subsequent opens
  // reuse the cached list; the user can hit refresh manually.
  useEffect(() => {
    if (open && status === 'idle' && ready) {
      void refresh()
    }
  }, [open, status, ready, refresh])

  // If the trigger table changes underneath the picker, drop the cached
  // list — those rows belong to a different table now and any pick would
  // mis-render.
  useEffect(() => {
    setRecords([])
    setStatus('idle')
    setError(null)
  }, [documentId, tableId])

  const label = useMemo(() => {
    if (!ready) return t('panels.sampleRow.noTableBound')
    return t('panels.sampleRow.useExisting')
  }, [ready, t])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="workflow-home-sample-row-picker"
          disabled={disabled || !ready}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          title={ready ? t('panels.sampleRow.tooltipReady') : t('panels.sampleRow.tooltipNotReady')}
        >
          <Search className="size-3.5 text-muted-foreground" />
          {label}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0" data-testid="workflow-home-sample-row-popover">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[12px] font-semibold text-muted-foreground">
          {t('panels.sampleRow.recentRows')}
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t('panels.sampleRow.refreshAria')}
            data-testid="workflow-home-sample-row-refresh"
            className="inline-grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
          >
            <RefreshCw className={`size-3 ${status === 'loading' ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="max-h-[260px] overflow-y-auto">
          {status === 'loading' && records.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">{t('panels.sampleRow.loading')}</div>
          ) : null}
          {status === 'error' ? (
            <div className="px-3 py-3 text-xs text-destructive" data-testid="workflow-home-sample-row-error">{error}</div>
          ) : null}
          {status === 'done' && records.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="workflow-home-sample-row-empty">
              {t('panels.sampleRow.empty')}
            </div>
          ) : null}
          {records.map((record) => {
            const preview = previewRecord(record)
            return (
              <button
                key={record.id}
                type="button"
                data-testid="workflow-home-sample-row-option"
                data-record-id={record.id}
                onClick={() => {
                  onPick(record.values, record)
                  setOpen(false)
                }}
                className="flex w-full flex-col items-start gap-0.5 border-b border-border/60 px-3 py-2 text-left text-xs text-foreground last:border-b-0 hover:bg-muted/40"
              >
                <span className="truncate font-medium">{preview.label}</span>
                {preview.hint ? <span className="truncate text-[11px] text-muted-foreground">{preview.hint}</span> : null}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** previewRecord summarises a DataRecord into a one-line label + optional
 *  hint so the picker rows are scannable without rendering the full payload.
 *  The label picks the first non-empty string value (usually the primary
 *  column); the hint shows the next non-empty value so the user can tell
 *  near-duplicates apart. Exported for the spec — keep the heuristic
 *  pinned so future changes don't silently regress the list UX. */
export function previewRecord(record: DataRecord): { label: string; hint: string } {
  const fields = Object.entries(record.values || {})
  const strings = fields
    .map(([, v]) => (typeof v === 'string' && v.trim() ? v.trim() : null))
    .filter((v): v is string => Boolean(v))
  const label = strings[0] ?? `Row #${record.id}`
  const hint = strings[1] ?? ''
  return { label, hint }
}
