import type { DataField } from '@/types/dataDocument'
import { getOperatorsForField } from './operators'
import type { FilterCondition, FilterOperator, FilterValue } from './types'

const ARRAY_OPERATORS: FilterOperator[] = [
  'isAnyOf', 'isNoneOf',
  'hasAnyOf', 'hasAllOf', 'isExactly', 'isNotExactly', 'hasNoneOf',
]
const EMPTY_OPERATORS: FilterOperator[] = ['isEmpty', 'isNotEmpty']

function expectsArray(operator: FilterOperator): boolean {
  return ARRAY_OPERATORS.includes(operator)
}

function expectsNoValue(operator: FilterOperator): boolean {
  return EMPTY_OPERATORS.includes(operator)
}

function coerceValueForOperator(prev: FilterValue, nextOperator: FilterOperator): FilterValue {
  if (expectsNoValue(nextOperator)) return null
  const wantsArray = expectsArray(nextOperator)
  const isArray = Array.isArray(prev)
  if (wantsArray && !isArray) {
    if (prev === null || prev === '') return []
    return [String(prev)]
  }
  if (!wantsArray && isArray) {
    return prev.length > 0 ? prev[0]! : null
  }
  return prev
}

function pickDefaultOperator(field: DataField | undefined): FilterOperator {
  if (!field) return 'is'
  const ops = getOperatorsForField(field)
  return ops[0] ?? 'is'
}

export function coerceConditionOnChange(
  prev: FilterCondition,
  next: Partial<FilterCondition>,
  fields: DataField[],
): FilterCondition {
  if (next.field_name !== undefined && next.field_name !== prev.field_name) {
    const newField = fields.find((f) => f.name === next.field_name)
    return {
      ...prev,
      field_name: next.field_name,
      operator: pickDefaultOperator(newField),
      value: null,
    }
  }
  if (next.operator !== undefined && next.operator !== prev.operator) {
    return {
      ...prev,
      operator: next.operator,
      value: coerceValueForOperator(prev.value, next.operator),
    }
  }
  if (next.value !== undefined) {
    return { ...prev, value: next.value }
  }
  return prev
}
