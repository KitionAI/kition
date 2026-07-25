import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, X } from 'lucide-react'
import type { DataField } from '@/types/dataDocument'
import { cn } from '@/lib/utils'
import type { FilterValue } from '../../types'
import { readChoices } from './choices'

export function ValueMultiSelect({
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
  const selectedNames = Array.isArray(value) ? value : []

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

  function toggle(name: string) {
    const set = new Set(selectedNames)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    onChange(Array.from(set))
  }
  function remove(name: string) {
    onChange(selectedNames.filter((n) => n !== name))
  }

  return (
    <div ref={rootRef} className="data-inline-filter-value">
      <button
        type="button"
        className={cn('data-inline-filter-cell-button', selectedNames.length === 0 && 'is-placeholder')}
        onClick={() => setOpen((o) => !o)}
      >
        {selectedNames.length === 0 ? (
          <span className="data-inline-filter-cell-label">{t('filter.chooseOptions')}</span>
        ) : (
          <span className="data-inline-filter-chip-list">
            {selectedNames.map((name) => {
              const c = choices.find((x) => x.name === name)
              return (
                <span
                  key={name}
                  className="data-inline-filter-chip"
                  style={c?.color ? { background: c.color } : undefined}
                >
                  {name}
                  <span
                    role="button"
                    className="data-inline-filter-chip-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(name)
                    }}
                  >
                    <X className="size-3" />
                  </span>
                </span>
              )
            })}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
      {open ? (
        <div className="data-inline-filter-cell-menu" role="listbox">
          {choices.length === 0 ? (
            <div className="data-inline-filter-cell-empty">{t('filter.noOptions')}</div>
          ) : null}
          {choices.map((c) => {
            const checked = selectedNames.includes(c.name)
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={checked}
                className={cn('data-inline-filter-cell-menu-item', checked && 'is-active')}
                onClick={() => toggle(c.name)}
              >
                <input type="checkbox" checked={checked} readOnly className="data-inline-filter-cell-menu-check" />
                {c.color ? (
                  <span className="data-inline-filter-choice-dot" style={{ background: c.color }} />
                ) : null}
                <span className="data-inline-filter-cell-label">{c.name}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
