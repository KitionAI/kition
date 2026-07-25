import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { DataField } from '@/types/dataDocument'
import { cn } from '@/lib/utils'
import type { FilterValue } from '../../types'
import { readChoices } from './choices'

export function ValueSingleSelect({
  field,
  value,
  onChange,
}: {
  field: DataField
  value: FilterValue
  onChange: (next: FilterValue) => void
}) {
  const { t } = useTranslation('table')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const choices = readChoices(field)
  const selected = choices.find((c) => c.name === value) || null

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
    <div ref={rootRef} className="data-inline-filter-value">
      <button
        type="button"
        className={cn('data-inline-filter-cell-button', !selected && 'is-placeholder')}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <>
            {selected.color ? (
              <span className="data-inline-filter-choice-dot" style={{ background: selected.color }} />
            ) : null}
            <span className="data-inline-filter-cell-label">{selected.name}</span>
          </>
        ) : (
          <span className="data-inline-filter-cell-label">{t('filter.chooseOption')}</span>
        )}
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
      {open ? (
        <div className="data-inline-filter-cell-menu" role="listbox">
          {choices.length === 0 ? (
            <div className="data-inline-filter-cell-empty">{t('filter.noOptions')}</div>
          ) : null}
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.name === value}
              className={cn('data-inline-filter-cell-menu-item', c.name === value && 'is-active')}
              onClick={() => {
                onChange(c.name)
                setOpen(false)
              }}
            >
              {c.color ? (
                <span className="data-inline-filter-choice-dot" style={{ background: c.color }} />
              ) : null}
              <span className="data-inline-filter-cell-label">{c.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
