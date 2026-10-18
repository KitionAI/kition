/**
 * The table filter tree as stored on views and dashboards. Shared types
 * only; the editing helpers live with the table feature.
 */
export type FilterConjunction = 'and' | 'or'

export type FilterOperator =
  | 'is' | 'isNot'
  | 'isEmpty' | 'isNotEmpty'
  | 'contains' | 'doesNotContain'
  | 'isGreater' | 'isGreaterEqual' | 'isLess' | 'isLessEqual'
  | 'isAnyOf' | 'isNoneOf'
  | 'hasAnyOf' | 'hasAllOf' | 'isExactly' | 'isNotExactly' | 'hasNoneOf'
  | 'isWithIn' | 'isBefore' | 'isAfter' | 'isOnOrBefore' | 'isOnOrAfter'

export type FilterValue = string | number | boolean | string[] | null

export type FilterCondition = {
  id: string
  kind: 'condition'
  field_name: string
  operator: FilterOperator
  value: FilterValue
}

export type FilterGroup = {
  id: string
  kind: 'group'
  conjunction: FilterConjunction
  children: FilterNode[]
}

export type FilterNode = FilterCondition | FilterGroup
