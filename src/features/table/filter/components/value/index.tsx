import type { DataField } from '@/types/dataDocument'
import type { FilterOperator, FilterValue } from '../../types'
import { ValueCheckbox } from './ValueCheckbox'
import { ValueDate } from './ValueDate'
import { ValueMultiSelect } from './ValueMultiSelect'
import { ValueNumber } from './ValueNumber'
import { ValueSingleSelect } from './ValueSingleSelect'
import { ValueText } from './ValueText'
import { ValueUser } from './ValueUser'

const EMPTY_OPERATORS: FilterOperator[] = ['isEmpty', 'isNotEmpty']

export function FilterValueEditor({
  field,
  operator,
  value,
  onChange,
}: {
  field: DataField | undefined
  operator: FilterOperator
  value: FilterValue
  onChange: (next: FilterValue) => void
}) {
  if (!field) return null
  if (EMPTY_OPERATORS.includes(operator)) return null
  if (field.type === 'attachment') return null
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'url':
      return <ValueText operator={operator} value={value} onChange={onChange} />
    case 'number':
    case 'rating':
    case 'auto_number':
      return <ValueNumber value={value} onChange={onChange} />
    case 'date':
    case 'datetime':
    case 'created_time':
    case 'last_modified_time':
      return <ValueDate value={value} onChange={onChange} />
    case 'checkbox':
      return <ValueCheckbox value={value} onChange={onChange} />
    case 'single_select':
      if (operator === 'isAnyOf' || operator === 'isNoneOf') {
        return <ValueMultiSelect field={field} value={value} onChange={onChange} />
      }
      return <ValueSingleSelect field={field} value={value} onChange={onChange} />
    case 'multi_select':
      return <ValueMultiSelect field={field} value={value} onChange={onChange} />
    case 'user':
    case 'created_by':
    case 'last_modified_by':
      return <ValueUser multi={operator === 'isAnyOf' || operator === 'isNoneOf'} value={value} onChange={onChange} />
    default:
      return null
  }
}
