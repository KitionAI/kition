import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'
import { cn } from '@/lib/utils'

export type TriggerTableOption = {
  tableId: string
  tableName: string
  documentTitle: string
}

type TriggerTableSelectProps = {
  value: string
  options: TriggerTableOption[]
  onChange: (nextTableId: string) => void
  disabled?: boolean
  /** Native sentinel option ("— Not bound (draft) —") is always rendered
   *  as the first item so users can revert to the draft state without
   *  leaving the drawer. Matches the previous <select>'s contract. */
  draftLabel?: string
  testId?: string
}

const buttonClassName = cn(
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors',
  'flex items-center justify-between gap-2',
  'hover:border-hairline-strong focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30',
  'disabled:bg-muted/40 disabled:text-muted-foreground disabled:hover:border-border',
)

function formatOptionLabel(option: TriggerTableOption): string {
  // The workflow editor lives inside a kitable scope, so the document
  // title prefix would be redundant ("333 · 6666" vs just "6666"). Show
  // the table name on its own — the scope is already implied by which
  // tab the user is in.
  return option.tableName
}

export function TriggerTableSelect({
  value,
  options,
  onChange,
  disabled,
  draftLabel,
  testId,
}: TriggerTableSelectProps) {
  const { t } = useTranslation('workflow')
  const effectiveDraftLabel = draftLabel ?? t('panels.triggerTable.draftLabel')
  const selected = value ? options.find((option) => option.tableId === value) || null : null
  const triggerLabel = selected ? formatOptionLabel(selected) : effectiveDraftLabel
  const isPlaceholder = !selected
  // Controlled open state so picking a row can close the popover. Radix's
  // default behaviour leaves it open because the row button isn't a
  // `PopoverClose` and our popover.tsx wrapper doesn't re-export one.
  const [open, setOpen] = useState(false)

  function handlePick(nextTableId: string) {
    onChange(nextTableId)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={buttonClassName}
          disabled={disabled}
          data-testid={testId}
          aria-haspopup="listbox"
        >
          <span className={cn('min-w-0 flex-1 truncate text-left', isPlaceholder && 'text-muted-foreground/80')}>
            {triggerLabel}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] max-w-none rounded-lg border border-border bg-card p-1 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
        onOpenAutoFocus={(event) => {
          // The list's first row autofocus stole focus from the trigger on
          // each open — let the trigger keep focus so keyboard users can
          // close with Escape without an extra Tab back.
          event.preventDefault()
        }}
      >
        <div role="listbox" aria-label={t('panels.triggerTable.selectAria')} className="flex max-h-[280px] flex-col overflow-y-auto">
          <SelectRow
            label={effectiveDraftLabel}
            selected={!selected}
            placeholder
            onSelect={() => handlePick('')}
          />
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground/80">{t('panels.triggerTable.emptyInScope')}</div>
          ) : (
            options.map((option) => (
              <SelectRow
                key={option.tableId}
                label={formatOptionLabel(option)}
                selected={selected?.tableId === option.tableId}
                onSelect={() => handlePick(option.tableId)}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SelectRow({
  label,
  selected,
  onSelect,
  placeholder,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  placeholder?: boolean
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
        'hover:bg-primary/10',
        selected ? 'bg-primary/10 text-foreground' : 'text-foreground',
        placeholder && 'text-muted-foreground',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected ? <Check className="size-3.5 text-primary" aria-hidden /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
