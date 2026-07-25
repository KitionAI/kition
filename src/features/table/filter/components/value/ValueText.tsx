import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui'
import type { FilterOperator, FilterValue } from '../../types'

export function ValueText({
  operator,
  value,
  onChange,
}: {
  operator: FilterOperator
  value: FilterValue
  onChange: (next: FilterValue) => void
}) {
  const { t } = useTranslation('table')
  const text = typeof value === 'string' ? value : ''
  const placeholder = operator === 'contains' || operator === 'doesNotContain' ? t('filter.valueContains') : t('filter.exactValue')
  return (
    <Input
      value={text}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="data-inline-filter-value-input"
    />
  )
}
