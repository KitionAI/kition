import type { DataField, DataFieldType } from '@/types/dataDocument'
import type { FilterOperator } from './types'

const TEXT_OPS: FilterOperator[] = ['is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty']
const NUMBER_OPS: FilterOperator[] = ['is', 'isNot', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual', 'isEmpty', 'isNotEmpty']
const DATE_OPS: FilterOperator[] = ['is', 'isNot', 'isWithIn', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isEmpty', 'isNotEmpty']
const SINGLE_SELECT_OPS: FilterOperator[] = ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty']
const MULTI_SELECT_OPS: FilterOperator[] = ['hasAnyOf', 'hasAllOf', 'isExactly', 'isNotExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty']
const USER_OPS: FilterOperator[] = ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty']
const CHECKBOX_OPS: FilterOperator[] = ['is']
const ATTACHMENT_OPS: FilterOperator[] = ['isEmpty', 'isNotEmpty']

const OPERATORS_BY_TYPE: Partial<Record<DataFieldType, FilterOperator[]>> = {
  text: TEXT_OPS,
  long_text: TEXT_OPS,
  url: TEXT_OPS,
  number: NUMBER_OPS,
  rating: NUMBER_OPS,
  auto_number: NUMBER_OPS,
  date: DATE_OPS,
  datetime: DATE_OPS,
  created_time: DATE_OPS,
  last_modified_time: DATE_OPS,
  single_select: SINGLE_SELECT_OPS,
  multi_select: MULTI_SELECT_OPS,
  user: USER_OPS,
  created_by: USER_OPS,
  last_modified_by: USER_OPS,
  checkbox: CHECKBOX_OPS,
  attachment: ATTACHMENT_OPS,
}

export function getOperatorsForField(field: DataField): FilterOperator[] {
  return OPERATORS_BY_TYPE[field.type] ?? []
}

export function isFieldFilterable(field: DataField): boolean {
  return getOperatorsForField(field).length > 0
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  doesNotContain: 'does not contain',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  isGreater: '>',
  isGreaterEqual: '≥',
  isLess: '<',
  isLessEqual: '≤',
  isAnyOf: 'is any of',
  isNoneOf: 'is none of',
  hasAnyOf: 'has any of',
  hasAllOf: 'has all of',
  isExactly: 'is exactly',
  isNotExactly: 'is not exactly',
  hasNoneOf: 'has none of',
  isWithIn: 'is within',
  isBefore: 'is before',
  isAfter: 'is after',
  isOnOrBefore: 'is on or before',
  isOnOrAfter: 'is on or after',
}

export function getOperatorLabel(operator: FilterOperator): string {
  return OPERATOR_LABELS[operator] ?? operator
}

/**
 * i18n key for an operator label. Symbol operators (>, ≥, <, ≤) stay language
 * neutral and are returned verbatim; word operators map to `filter.operators.*`.
 */
export function getOperatorLabelKey(operator: FilterOperator): string {
  return `filter.operators.${operator}`
}
