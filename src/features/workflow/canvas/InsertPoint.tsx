import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Filter, Mail, Plus } from 'lucide-react'
import { WorkflowNodePicker, type InsertableActionType } from './WorkflowNodePicker'

/**
 * InsertPoint is the small "+" affordance that lives between every pair of
 * canvas nodes. Clicking it opens a popover with the available step kinds
 * the user can insert at that slot.
 *
 * v1 wires only "Add action" (real handler). "Add filter" exists in the
 * menu so the muscle memory builds, but the item is gated on a future
 * flag — clicking it currently closes the popover without dispatching, so
 * the muscle memory builds with no side effects.
 */
export interface InsertPointProps {
  /** Test hook so e2e can target the insert slot between specific nodes. */
  testId?: string
  /** When true, the disabled "+" still renders but is not clickable; used
   *  while the canvas itself is in a saving / loading state to avoid
   *  introducing a partially-saved insertion. */
  disabled?: boolean
  /** When provided, called when the user picks "Add filter" / "Add action"
   *  from the popover. v1 callers may leave this undefined to disable
   *  insertion entirely — the "+" still renders so empty slots are visible. */
  onInsert?: (kind: 'filter' | 'action', actionType?: InsertableActionType) => void
}

export function InsertPoint({ testId, disabled, onInsert }: InsertPointProps) {
  const { t } = useTranslation('workflow')
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(event: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative flex flex-col items-center" data-testid={testId || 'workflow-insert-point'}>
      <div className="h-4 w-[2px] bg-border" />
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          setOpen((cur) => !cur)
        }}
        disabled={disabled}
        aria-label={t('canvas.insertPoint.insertStep')}
        aria-expanded={open}
        data-testid={`${testId || 'workflow-insert-point'}-button`}
        className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:bg-primary/15 hover:text-primary hover:border-solid focus:border-ring focus:text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="size-3" />
      </button>
      <div className="h-4 w-[2px] bg-border" />

      {pickerOpen ? (
        <WorkflowNodePicker
          onClose={() => setPickerOpen(false)}
          onPick={(actionType) => {
            onInsert?.('action', actionType)
            setPickerOpen(false)
          }}
        />
      ) : null}
      {open ? (
        <div
          role="menu"
          data-testid={`${testId || 'workflow-insert-point'}-menu`}
          className="absolute left-9 top-1/2 z-10 -translate-y-1/2 grid w-44 gap-0.5 rounded-lg border border-border bg-card p-1 text-sm shadow-[0_8px_24px_rgba(15,15,15,0.08)]"
        >
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => {
              setPickerOpen(true)
              setOpen(false)
            }}
            data-testid={`${testId || 'workflow-insert-point'}-add-action`}
          >
            <Mail className="size-3.5 text-primary" />
            <span className="flex-1">{t('canvas.insertPoint.addAction')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
            onClick={() => {
              onInsert?.('filter')
              setOpen(false)
            }}
            data-testid={`${testId || 'workflow-insert-point'}-add-filter`}
          >
            <Filter className="size-3.5 text-warning" />
            <span className="flex-1">{t('canvas.insertPoint.addFilter')}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
