import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { DataField } from '@/types/dataDocument'
import { cn } from '@/lib/utils'
import { getOperatorLabelKey, getOperatorsForField } from '../operators'
import type { FilterOperator } from '../types'

export function FilterOperatorSelect({
  field,
  value,
  onChange,
}: {
  field: DataField | undefined
  value: FilterOperator
  onChange: (next: FilterOperator) => void
}) {
  const { t } = useTranslation('table')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const operators = field ? getOperatorsForField(field) : []
  const disabled = !field || operators.length === 0

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onOutside)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onOutside)
      window.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={rootRef} className="data-inline-filter-cell">
      <button
        type="button"
        disabled={disabled}
        className={cn('data-inline-filter-cell-button', disabled && 'is-disabled')}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className="data-inline-filter-cell-label">{t(getOperatorLabelKey(value))}</span>
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
      {open ? (
        <div className="data-inline-filter-cell-menu" role="listbox">
          {operators.map((op) => (
            <button
              key={op}
              type="button"
              role="option"
              aria-selected={op === value}
              className={cn('data-inline-filter-cell-menu-item', op === value && 'is-active')}
              onClick={() => {
                onChange(op)
                setOpen(false)
              }}
            >
              {t(getOperatorLabelKey(op))}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
