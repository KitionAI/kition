import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DataField } from '@/types/dataDocument'
import { coerceConditionOnChange } from '../coerce'
import type { FilterCondition } from '../types'
import { FilterFieldSelect } from './FilterFieldSelect'
import { FilterOperatorSelect } from './FilterOperatorSelect'
import { FilterValueEditor } from './value'

export function FilterConditionRow({
  fields,
  condition,
  onUpdate,
  onRemove,
}: {
  fields: DataField[]
  condition: FilterCondition
  onUpdate: (next: FilterCondition) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('table')
  const field = fields.find((f) => f.name === condition.field_name)
  return (
    <div className="data-inline-filter-condition">
      <FilterFieldSelect
        fields={fields}
        value={condition.field_name}
        onChange={(name) => onUpdate(coerceConditionOnChange(condition, { field_name: name }, fields))}
      />
      <FilterOperatorSelect
        field={field}
        value={condition.operator}
        onChange={(op) => onUpdate(coerceConditionOnChange(condition, { operator: op }, fields))}
      />
      <div className="data-inline-filter-value">
        <FilterValueEditor
          field={field}
          operator={condition.operator}
          value={condition.value}
          onChange={(v) => onUpdate(coerceConditionOnChange(condition, { value: v }, fields))}
        />
      </div>
      <button
        type="button"
        className="data-inline-filter-remove"
        onClick={onRemove}
        aria-label={t('filter.removeCondition')}
        title={t('filter.removeCondition')}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}
