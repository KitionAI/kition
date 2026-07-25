import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentModelOption } from '@/features/agent/lib/agentConfig'
import { cn } from '@/lib/utils'

type AgentModelPickerProps = {
  className?: string
  disabled?: boolean
  emptyLabel?: string
  menuPlacement?: 'top' | 'bottom'
  options: AgentModelOption[]
  value: string
  ariaLabel?: string
  variant?: 'default' | 'compact'
  onChange: (value: string) => void
}

type AgentModelGroup = {
  providerLabel: string
  options: AgentModelOption[]
}

export function AgentModelPicker({
  className,
  disabled = false,
  emptyLabel,
  menuPlacement = 'bottom',
  options,
  value,
  ariaLabel,
  variant = 'default',
  onChange,
}: AgentModelPickerProps) {
  const { t } = useTranslation('agent')
  const resolvedEmptyLabel = emptyLabel ?? t('modelPicker.noModelConfigured')
  const resolvedAriaLabel = ariaLabel ?? t('modelPicker.chooseModel')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const selectedOption = options.find((option) => option.key === value) || options[0] || null
  const normalizedQuery = query.trim().toLowerCase()
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) {
      return options
    }

    return options.filter((option) =>
      `${option.modelName} ${option.providerLabel} ${option.providerKind}`
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [normalizedQuery, options])
  const groupedOptions = useMemo<AgentModelGroup[]>(() => {
    const groups = new Map<string, AgentModelOption[]>()

    for (const option of filteredOptions) {
      const providerLabel = option.providerLabel || option.providerKind
      const group = groups.get(providerLabel)
      if (group) {
        group.push(option)
        continue
      }
      groups.set(providerLabel, [option])
    }

    return Array.from(groups.entries()).map(([providerLabel, items]) => ({
      providerLabel,
      options: items,
    }))
  }, [filteredOptions])
  const highlightedOption = filteredOptions[highlightedIndex] || null

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHighlightedIndex(0)
      return
    }

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [normalizedQuery, open])

  useEffect(() => {
    if (!open || !highlightedOption) {
      return
    }

    optionRefs.current[highlightedOption.key]?.scrollIntoView({ block: 'nearest' })
  }, [highlightedOption, open])

  function handleSelect(nextValue: string) {
    onChange(nextValue)
    setOpen(false)
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!filteredOptions.length) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.min(filteredOptions.length - 1, current + 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(0, current - 1))
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const nextOption = filteredOptions[highlightedIndex] || filteredOptions[0]
      if (nextOption) {
        handleSelect(nextOption.key)
      }
    }
  }

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      {variant === 'compact' ? (
        <button
          type="button"
          disabled={disabled || !options.length}
          aria-label={resolvedAriaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            'flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
            'disabled:pointer-events-none disabled:opacity-55',
            open && 'bg-muted text-foreground',
          )}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="truncate">
            {selectedOption ? `${selectedOption.modelName} · ${selectedOption.providerLabel}` : resolvedEmptyLabel}
          </span>
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled || !options.length}
          aria-label={resolvedAriaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2 text-left transition-colors',
            'hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
            'disabled:pointer-events-none disabled:opacity-55',
            open && 'border-ring/50 bg-card',
          )}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('modelPicker.modelLabel')}
            </span>
            <span
              className={cn(
                'mt-0.5 block truncate text-sm font-medium',
                selectedOption ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {selectedOption ? `${selectedOption.modelName} · ${selectedOption.providerLabel}` : resolvedEmptyLabel}
            </span>
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
            <ChevronDown className={cn('size-4 transition-transform duration-200', open && 'rotate-180')} />
          </span>
        </button>
      )}

      {open ? (
        <div
          className={cn(
            'absolute z-50 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-floating',
            'backdrop-blur-xl',
            variant === 'compact' ? 'left-0 w-max min-w-[260px] max-w-[340px]' : 'left-0 w-full',
            menuPlacement === 'top'
              ? 'bottom-[calc(100%+0.5rem)]'
              : 'top-[calc(100%+0.5rem)]',
          )}
        >
          <div className="border-b border-border/70 p-2.5">
            <label className="flex items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm text-muted-foreground">
              <Search className="size-4 shrink-0" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                placeholder={t('modelPicker.searchPlaceholder')}
              />
            </label>
          </div>

          <div className="max-h-80 overflow-y-auto p-2">
            {groupedOptions.length ? (
              groupedOptions.map((group) => (
                <div key={group.providerLabel} className="pb-2 last:pb-0">
                  <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {group.providerLabel}
                  </div>
                  <div className="mt-1 grid gap-1">
                    {group.options.map((option) => {
                      const isSelected = option.key === value
                      const isHighlighted = option.key === highlightedOption?.key

                      return (
                        <button
                          key={option.key}
                          ref={(node) => {
                            optionRefs.current[option.key] = node
                          }}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                            isSelected && 'bg-accent/75 text-foreground',
                            !isSelected && isHighlighted && 'bg-muted/80 text-foreground',
                            !isSelected && !isHighlighted && 'hover:bg-muted/70',
                          )}
                          onMouseEnter={() => setHighlightedIndex(filteredOptions.findIndex((item) => item.key === option.key))}
                          onClick={() => handleSelect(option.key)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{option.modelName}</span>
                            <span className="block truncate text-xs text-muted-foreground">{option.providerLabel}</span>
                          </span>
                          <span className={cn('shrink-0 text-accent-foreground', !isSelected && 'opacity-0')}>
                            <Check className="size-4" />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('modelPicker.noMatches', { query: query.trim() })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
