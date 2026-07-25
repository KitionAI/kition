import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { DataField } from '@/types/dataDocument'
import { getFieldIcon } from '@/features/table/lib/tableEditorShared'
import { cn } from '@/lib/utils'
import { isFieldFilterable } from '../operators'

export function FilterFieldSelect({
  fields,
  value,
  onChange,
}: {
  fields: DataField[]
  value: string
  onChange: (next: string) => void
}) {
  const { t } = useTranslation('table')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const filterable = fields.filter(isFieldFilterable)
  const selected = fields.find((f) => f.name === value)

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
        className={cn('data-inline-filter-cell-button', !selected && 'is-placeholder')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="data-inline-filter-cell-icon">
          {selected ? getFieldIcon(selected) : null}
        </span>
        <span className="data-inline-filter-cell-label">
          {selected ? selected.title : t('filter.chooseField')}
        </span>
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
      {open ? (
        <div className="data-inline-filter-cell-menu" role="listbox">
          {filterable.map((field) => (
            <button
              key={field.id}
              type="button"
              role="option"
              aria-selected={field.name === value}
              className={cn('data-inline-filter-cell-menu-item', field.name === value && 'is-active')}
              onClick={() => {
                onChange(field.name)
                setOpen(false)
              }}
            >
              <span className="data-inline-filter-cell-icon">{getFieldIcon(field)}</span>
              <span className="data-inline-filter-cell-label">{field.title}</span>
            </button>
          ))}
          {filterable.length === 0 ? (
            <div className="data-inline-filter-cell-empty">{t('filter.noFilterableFields')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
