import type { FilterCondition, FilterConjunction, FilterGroup } from '@/types/tableFilter'

export type {
  FilterCondition,
  FilterConjunction,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
} from '@/types/tableFilter'

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
