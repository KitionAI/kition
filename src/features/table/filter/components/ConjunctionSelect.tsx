import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FilterConjunction } from '../types'

const PHRASE_KEYS: Record<FilterConjunction, string> = {
  and: 'filter.conjunction.and',
  or: 'filter.conjunction.or',
}

export function ConjunctionSelect({
  value,
  onChange,
  className,
}: {
  value: FilterConjunction
  onChange: (next: FilterConjunction) => void
  className?: string
}) {
  const { t } = useTranslation('table')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

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
    <div ref={rootRef} className={cn('data-inline-filter-conjunction', className)}>
      <button
        type="button"
        className="data-inline-filter-conjunction-button"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{t(PHRASE_KEYS[value])}</span>
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
      {open ? (
        <div className="data-inline-filter-conjunction-menu" role="menu">
          {(['and', 'or'] as FilterConjunction[]).map((opt) => (
            <button
              key={opt}
              type="button"
              role="menuitemradio"
              aria-checked={value === opt}
              className={cn('data-inline-filter-conjunction-item', value === opt && 'is-active')}
              onClick={() => {
                onChange(opt)
                setOpen(false)
              }}
            >
              {t(PHRASE_KEYS[opt])}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
