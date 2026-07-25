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

let _idCounter = 0
function generateFilterNodeId(prefix: 'cond' | 'grp'): string {
  _idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`
}

export function createEmptyFilterCondition(): FilterCondition {
  return {
    id: generateFilterNodeId('cond'),
    kind: 'condition',
    field_name: '',
    operator: 'is',
    value: null,
  }
}

export function createEmptyFilterGroup(conjunction: FilterConjunction = 'and'): FilterGroup {
  return {
    id: generateFilterNodeId('grp'),
    kind: 'group',
    conjunction,
    children: [createEmptyFilterCondition()],
  }
}
