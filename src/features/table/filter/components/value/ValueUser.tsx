import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui'
import type { FilterValue } from '../../types'

export function ValueUser({
  multi,
  value,
  onChange,
}: {
  multi: boolean
  value: FilterValue
  onChange: (next: FilterValue) => void
}) {
  const { t } = useTranslation('table')
  if (multi) {
    const text = Array.isArray(value) ? value.join(', ') : ''
    return (
      <Input
        value={text}
        placeholder={t('filter.userNamesCommaSeparated')}
        onChange={(e) => {
          const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
          onChange(parts.length ? parts : null)
        }}
        className="data-inline-filter-value-input"
      />
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <Input
      value={text}
      placeholder={t('filter.userName')}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="data-inline-filter-value-input"
    />
  )
}
