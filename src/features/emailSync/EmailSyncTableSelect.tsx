import { Check, ChevronDown, Table2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/registry/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover'

export type EmailSyncTableOption = {
  id: number
  name: string
  title: string
}

export function EmailSyncTableSelect({
  value,
  options,
  loading,
  disabled,
  kitablePath,
  onChange,
}: {
  value: number | null
  options: EmailSyncTableOption[]
  loading?: boolean
  disabled?: boolean
  kitablePath: string
  onChange: (tableId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value) || null
  const unavailable = Boolean(value && !selected && !loading)
  const label = loading
    ? 'Loading tables...'
    : selected?.title || (unavailable ? 'Selected table is unavailable' : 'Select a table')

  return (
    <div className="grid min-w-0 gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors',
              'hover:border-hairline-strong focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30',
              'disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground',
              unavailable && 'border-destructive/50 text-destructive',
            )}
            disabled={disabled || loading || options.length === 0}
            aria-label="Destination table"
            aria-haspopup="listbox"
            data-testid="email-sync-table-select"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Table2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{label}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] max-w-none rounded-lg border border-border bg-card p-0 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
        >
          <Command>
            <CommandInput placeholder="Search tables..." data-testid="email-sync-table-search" />
            <CommandList role="listbox" aria-label="Tables in the current Kitable">
              <CommandEmpty>No matching tables.</CommandEmpty>
              <CommandGroup heading="Tables in this Kitable">
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.title} ${option.name} ${option.id}`}
                    onSelect={() => {
                      onChange(option.id)
                      setOpen(false)
                    }}
                    data-testid={`email-sync-table-option-${option.id}`}
                  >
                    <Check className={cn('size-4 text-primary', selected?.id !== option.id && 'opacity-0')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{option.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="truncate text-xs text-muted-foreground" title={kitablePath}>
        Current Kitable: {kitablePath}
      </p>
    </div>
  )
}
