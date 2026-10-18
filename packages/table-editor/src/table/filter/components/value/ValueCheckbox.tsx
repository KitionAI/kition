import { useTranslation } from 'react-i18next'
import type { FilterValue } from '../../types'

export function ValueCheckbox({
  value,
  onChange,
}: {
  value: FilterValue
  onChange: (next: FilterValue) => void
}) {
  const { t } = useTranslation('table')
  const checked = value === true
  return (
    <label className="data-inline-filter-value-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{checked ? t('filter.checked') : t('filter.unchecked')}</span>
    </label>
  )
}
