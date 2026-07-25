import type { DataField, DataFieldType, DataRecord } from '@/types/dataDocument'
import { getOperatorsForField } from './operators'
import type {
  FilterCondition,
  FilterConjunction,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
} from './types'

const KNOWN_OPERATORS = new Set<FilterOperator>([
  'is', 'isNot', 'isEmpty', 'isNotEmpty',
  'contains', 'doesNotContain',
  'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual',
  'isAnyOf', 'isNoneOf',
  'hasAnyOf', 'hasAllOf', 'isExactly', 'isNotExactly', 'hasNoneOf',
  'isWithIn', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter',
])

const EMPTY_OPERATORS: FilterOperator[] = ['isEmpty', 'isNotEmpty']
const DATE_TYPES: DataFieldType[] = ['date', 'datetime', 'created_time', 'last_modified_time']
const NUMBER_TYPES: DataFieldType[] = ['number', 'rating', 'auto_number']
const MULTI_ARRAY_TYPES: DataFieldType[] = ['multi_select']

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (isNullish(v)) return []
  return [v]
}

function setEq(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const x of b) if (!sa.has(x)) return false
  return true
}

function toDay(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const ms = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function normalizeCellValue(field: DataField, raw: unknown): unknown {
  if (DATE_TYPES.includes(field.type)) return toDay(raw)
  if (NUMBER_TYPES.includes(field.type)) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    return null
  }
  if (MULTI_ARRAY_TYPES.includes(field.type)) {
    const arr = Array.isArray(raw) ? raw.filter((x) => !isNullish(x)) : []
    return arr
  }
  if (field.type === 'checkbox') return Boolean(raw)
  if (field.type === 'attachment') {
    const has = Array.isArray(raw) ? raw.length > 0 : !isNullish(raw)
    return has ? 'present' : null
  }
  if (field.type === 'user' || field.type === 'created_by' || field.type === 'last_modified_by') {
    if (Array.isArray(raw)) return raw.filter((x) => !isNullish(x)).map(String)
    if (isNullish(raw)) return null
    return String(raw)
  }
  if (isNullish(raw)) return null
  const s = String(raw).trim()
  return s === '' ? null : s
}

type Evaluator = (cell: unknown, value: FilterValue) => boolean

const EVALUATORS: Record<FilterOperator, Evaluator> = {
  is: (c, v) => c === v,
  isNot: (c, v) => c !== v,
  contains: (c, v) => String(c ?? '').toLowerCase().includes(String(v ?? '').toLowerCase()),
  doesNotContain: (c, v) => !String(c ?? '').toLowerCase().includes(String(v ?? '').toLowerCase()),
  isEmpty: (c) => isNullish(c) || (Array.isArray(c) && c.length === 0),
  isNotEmpty: (c) => !(isNullish(c) || (Array.isArray(c) && c.length === 0)),
  isGreater: (c, v) => typeof c === 'number' && typeof v === 'number' && c > v,
  isGreaterEqual: (c, v) => typeof c === 'number' && typeof v === 'number' && c >= v,
  isLess: (c, v) => typeof c === 'number' && typeof v === 'number' && c < v,
  isLessEqual: (c, v) => typeof c === 'number' && typeof v === 'number' && c <= v,
  isAnyOf: (c, v) => asArray(v).includes(c),
  isNoneOf: (c, v) => !asArray(v).includes(c),
  hasAnyOf: (c, v) => asArray(c).some((x) => asArray(v).includes(x)),
  hasAllOf: (c, v) => asArray(v).every((x) => asArray(c).includes(x)),
  hasNoneOf: (c, v) => !asArray(c).some((x) => asArray(v).includes(x)),
  isExactly: (c, v) => setEq(asArray(c), asArray(v)),
  isNotExactly: (c, v) => !setEq(asArray(c), asArray(v)),
  isWithIn: (c, v) => {
    const cd = typeof c === 'number' ? c : toDay(c)
    const vd = toDay(v as string | number | null)
    return cd !== null && vd !== null && cd === vd
  },
  isBefore: (c, v) => {
    const cd = typeof c === 'number' ? c : toDay(c)
    const vd = toDay(v as string | number | null)
    return cd !== null && vd !== null && cd < vd
  },
  isAfter: (c, v) => {
    const cd = typeof c === 'number' ? c : toDay(c)
    const vd = toDay(v as string | number | null)
    return cd !== null && vd !== null && cd > vd
  },
  isOnOrBefore: (c, v) => {
    const cd = typeof c === 'number' ? c : toDay(c)
    const vd = toDay(v as string | number | null)
    return cd !== null && vd !== null && cd <= vd
  },
  isOnOrAfter: (c, v) => {
    const cd = typeof c === 'number' ? c : toDay(c)
    const vd = toDay(v as string | number | null)
    return cd !== null && vd !== null && cd >= vd
  },
}

export function isConditionActive(cond: FilterCondition, fields: DataField[]): boolean {
  const field = fields.find((f) => f.name === cond.field_name)
  if (!field) return false
  const allowed = getOperatorsForField(field)
  if (!allowed.includes(cond.operator)) return false
  if (EMPTY_OPERATORS.includes(cond.operator)) return true
  const v = cond.value
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

export function filterTreeHasActiveCondition(node: FilterNode | null): boolean {
  if (!node) return false
  if (node.kind === 'condition') {
    if (EMPTY_OPERATORS.includes(node.operator)) return Boolean(node.field_name)
    const v = node.value
    if (v === null || v === undefined) return false
    if (typeof v === 'string' && v.trim() === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return Boolean(node.field_name)
  }
  return node.children.some((c) => filterTreeHasActiveCondition(c))
}

export function countFilterConditions(node: FilterNode | null): number {
  if (!node) return 0
  if (node.kind === 'condition') return filterTreeHasActiveCondition(node) ? 1 : 0
  return node.children.reduce((n, c) => n + countFilterConditions(c), 0)
}

function normalizeFilterValue(field: DataField, value: FilterValue): FilterValue {
  // For date fields the cell is already a UTC day-start ms timestamp.
  // Normalize the filter value the same way so `is`/`isNot` (===) works.
  if (DATE_TYPES.includes(field.type)) {
    return toDay(value as string | number | null)
  }
  // For number fields the cell is already a number; coerce string filter values.
  if (NUMBER_TYPES.includes(field.type) && typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  return value
}

function evaluateCondition(cond: FilterCondition, record: DataRecord, fields: DataField[]): boolean {
  if (!isConditionActive(cond, fields)) return true
  const field = fields.find((f) => f.name === cond.field_name)
  if (!field) return true
  const cell = normalizeCellValue(field, record.values?.[cond.field_name] ?? null)
  const filterValue = normalizeFilterValue(field, cond.value)
  const evaluator = EVALUATORS[cond.operator]
  if (!evaluator) return true
  try {
    const r = evaluator(cell, filterValue)
    return typeof r === 'boolean' ? r : true
  } catch {
    return true
  }
}

export function evaluateFilterTree(
  tree: FilterGroup,
  record: DataRecord,
  fields: DataField[],
): boolean {
  const activeChildren = tree.children.filter((c) => filterTreeHasActiveCondition(c))
  if (activeChildren.length === 0) return true
  const evalNode = (n: FilterNode): boolean => {
    if (n.kind === 'condition') return evaluateCondition(n, record, fields)
    return evaluateFilterTree(n, record, fields)
  }
  if (tree.conjunction === 'or') return activeChildren.some(evalNode)
  return activeChildren.every(evalNode)
}

function isConjunction(v: unknown): v is FilterConjunction {
  return v === 'and' || v === 'or'
}

function parseNode(raw: unknown): FilterNode | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.kind === 'condition') {
    if (typeof obj.id !== 'string') return null
    if (typeof obj.field_name !== 'string') return null
    if (typeof obj.operator !== 'string' || !KNOWN_OPERATORS.has(obj.operator as FilterOperator)) return null
    const value = obj.value
    const isValueOk =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((x) => typeof x === 'string'))
    if (!isValueOk) return null
    return {
      id: obj.id,
      kind: 'condition',
      field_name: obj.field_name,
      operator: obj.operator as FilterOperator,
      value: value as FilterValue,
    }
  }
  if (obj.kind === 'group') {
    if (typeof obj.id !== 'string') return null
    if (!isConjunction(obj.conjunction)) return null
    if (!Array.isArray(obj.children)) return null
    const children: FilterNode[] = []
    for (const c of obj.children) {
      const parsed = parseNode(c)
      if (!parsed) return null
      children.push(parsed)
    }
    return { id: obj.id, kind: 'group', conjunction: obj.conjunction, children }
  }
  return null
}

export function parseFilterTree(raw: unknown): FilterGroup | null {
  const node = parseNode(raw)
  if (!node || node.kind !== 'group') return null
  return node
}
