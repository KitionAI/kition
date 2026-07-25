import { describe, expect, it } from 'vitest'
import type { DataField, DataRecord } from '@/types/dataDocument'
import {
  countFilterConditions,
  evaluateFilterTree,
  filterTreeHasActiveCondition,
  isConditionActive,
  parseFilterTree,
} from './evaluate'
import type { FilterCondition, FilterGroup } from './types'

function field(name: string, type: DataField['type']): DataField {
  return {
    id: 1, user_id: 1, document_id: 1, table_id: 1,
    name, title: name, type,
    required: false, unique: false, readonly: false, is_primary: false,
    order: 0,
    options: null, ai_config: null,
    created_at: '', updated_at: '',
  }
}

function record(values: Record<string, unknown>): DataRecord {
  return {
    id: 1, user_id: 1, document_id: 1, table_id: 1,
    row_key: 'r', order: 0,
    values: values as DataRecord['values'],
    created_at: '', updated_at: '',
  }
}

const labelField = field('label', 'text')
const qtyField = field('qty', 'number')
const dateField = field('due', 'date')
const stageField = field('stage', 'single_select')
const tagsField = field('tags', 'multi_select')
const flagField = field('flag', 'checkbox')

function cond(over: Partial<FilterCondition>): FilterCondition {
  return { id: 'c1', kind: 'condition', field_name: 'label', operator: 'is', value: null, ...over }
}
function group(children: FilterGroup['children'], conjunction: 'and' | 'or' = 'and'): FilterGroup {
  return { id: 'g1', kind: 'group', conjunction, children }
}

describe('isConditionActive', () => {
  it('is false when field is unknown', () => {
    expect(isConditionActive(cond({ field_name: 'nope', value: 'x' }), [labelField])).toBe(false)
  })
  it('is false when operator is not allowed for the field', () => {
    expect(isConditionActive(cond({ field_name: 'label', operator: 'hasAnyOf', value: ['x'] }), [labelField])).toBe(false)
  })
  it('is true for isEmpty regardless of value', () => {
    expect(isConditionActive(cond({ operator: 'isEmpty', value: null }), [labelField])).toBe(true)
  })
  it('is false when value is null/empty-string/empty-array', () => {
    expect(isConditionActive(cond({ operator: 'contains', value: null }), [labelField])).toBe(false)
    expect(isConditionActive(cond({ operator: 'contains', value: '' }), [labelField])).toBe(false)
    expect(isConditionActive(cond({ field_name: 'tags', operator: 'hasAnyOf', value: [] }), [tagsField])).toBe(false)
  })
  it('is true when value is present', () => {
    expect(isConditionActive(cond({ operator: 'contains', value: 'x' }), [labelField])).toBe(true)
  })
})

describe('evaluateFilterTree — text operators', () => {
  const r = record({ label: 'Hello world' })
  it('is matches exact', () => {
    expect(evaluateFilterTree(group([cond({ value: 'Hello world' })]), r, [labelField])).toBe(true)
    expect(evaluateFilterTree(group([cond({ value: 'nope' })]), r, [labelField])).toBe(false)
  })
  it('contains is case-insensitive', () => {
    expect(evaluateFilterTree(group([cond({ operator: 'contains', value: 'HELLO' })]), r, [labelField])).toBe(true)
  })
  it('doesNotContain inverts contains', () => {
    expect(evaluateFilterTree(group([cond({ operator: 'doesNotContain', value: 'cat' })]), r, [labelField])).toBe(true)
  })
  it('isEmpty matches empty record value', () => {
    expect(evaluateFilterTree(group([cond({ operator: 'isEmpty', value: null })]), record({ label: '' }), [labelField])).toBe(true)
  })
})

describe('evaluateFilterTree — number operators', () => {
  it('is / isGreater / isLess / isGreaterEqual / isLessEqual', () => {
    const r = record({ qty: 7 })
    const mk = (op: any, v: any): FilterGroup => group([cond({ field_name: 'qty', operator: op, value: v })])
    expect(evaluateFilterTree(mk('is', 7), r, [qtyField])).toBe(true)
    expect(evaluateFilterTree(mk('isGreater', 6), r, [qtyField])).toBe(true)
    expect(evaluateFilterTree(mk('isGreaterEqual', 7), r, [qtyField])).toBe(true)
    expect(evaluateFilterTree(mk('isLess', 8), r, [qtyField])).toBe(true)
    expect(evaluateFilterTree(mk('isLessEqual', 7), r, [qtyField])).toBe(true)
    expect(evaluateFilterTree(mk('isGreater', 7), r, [qtyField])).toBe(false)
  })
})

describe('evaluateFilterTree — date operators', () => {
  it('is matches same calendar day regardless of time of day', () => {
    const r = record({ due: '2026-06-13T18:30:00Z' })
    const mk = (op: any, v: any): FilterGroup => group([cond({ field_name: 'due', operator: op, value: v })])
    expect(evaluateFilterTree(mk('is', '2026-06-13'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('isWithIn', '2026-06-13'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('isBefore', '2026-06-14'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('isAfter', '2026-06-12'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('isOnOrBefore', '2026-06-13'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('isOnOrAfter', '2026-06-13'), r, [dateField])).toBe(true)
    expect(evaluateFilterTree(mk('is', '2026-06-14'), r, [dateField])).toBe(false)
  })
})

describe('evaluateFilterTree — single_select operators', () => {
  it('is / isAnyOf / isNoneOf', () => {
    const r = record({ stage: 'todo' })
    const mk = (op: any, v: any): FilterGroup => group([cond({ field_name: 'stage', operator: op, value: v })])
    expect(evaluateFilterTree(mk('is', 'todo'), r, [stageField])).toBe(true)
    expect(evaluateFilterTree(mk('isAnyOf', ['todo', 'done']), r, [stageField])).toBe(true)
    expect(evaluateFilterTree(mk('isNoneOf', ['done']), r, [stageField])).toBe(true)
    expect(evaluateFilterTree(mk('isNoneOf', ['todo']), r, [stageField])).toBe(false)
  })
})

describe('evaluateFilterTree — multi_select operators', () => {
  it('hasAnyOf / hasAllOf / isExactly / hasNoneOf', () => {
    const r = record({ tags: ['red', 'green'] })
    const mk = (op: any, v: any): FilterGroup => group([cond({ field_name: 'tags', operator: op, value: v })])
    expect(evaluateFilterTree(mk('hasAnyOf', ['red']), r, [tagsField])).toBe(true)
    expect(evaluateFilterTree(mk('hasAllOf', ['red', 'green']), r, [tagsField])).toBe(true)
    expect(evaluateFilterTree(mk('hasAllOf', ['red', 'blue']), r, [tagsField])).toBe(false)
    expect(evaluateFilterTree(mk('isExactly', ['green', 'red']), r, [tagsField])).toBe(true)
    expect(evaluateFilterTree(mk('isExactly', ['red']), r, [tagsField])).toBe(false)
    expect(evaluateFilterTree(mk('hasNoneOf', ['blue']), r, [tagsField])).toBe(true)
  })
})

describe('evaluateFilterTree — checkbox', () => {
  it('is true / is false', () => {
    const r = record({ flag: true })
    const mk = (v: any): FilterGroup => group([cond({ field_name: 'flag', operator: 'is', value: v })])
    expect(evaluateFilterTree(mk(true), r, [flagField])).toBe(true)
    expect(evaluateFilterTree(mk(false), r, [flagField])).toBe(false)
  })
})

describe('evaluateFilterTree — AND/OR semantics', () => {
  const r = record({ label: 'apple', qty: 5 })
  it('AND requires all active children to pass', () => {
    const tree = group([
      cond({ field_name: 'label', operator: 'is', value: 'apple' }),
      cond({ field_name: 'qty', operator: 'isGreater', value: 4 }),
    ], 'and')
    expect(evaluateFilterTree(tree, r, [labelField, qtyField])).toBe(true)
    const tree2 = group([
      cond({ field_name: 'label', operator: 'is', value: 'apple' }),
      cond({ field_name: 'qty', operator: 'isGreater', value: 99 }),
    ], 'and')
    expect(evaluateFilterTree(tree2, r, [labelField, qtyField])).toBe(false)
  })
  it('OR passes if any active child passes', () => {
    const tree = group([
      cond({ field_name: 'label', operator: 'is', value: 'pear' }),
      cond({ field_name: 'qty', operator: 'isGreater', value: 4 }),
    ], 'or')
    expect(evaluateFilterTree(tree, r, [labelField, qtyField])).toBe(true)
  })
  it('inactive children are ignored', () => {
    const tree = group([
      cond({ field_name: 'label', operator: 'contains', value: '' }), // inactive
      cond({ field_name: 'qty', operator: 'isGreater', value: 4 }),
    ], 'and')
    expect(evaluateFilterTree(tree, r, [labelField, qtyField])).toBe(true)
  })
  it('empty group passes', () => {
    expect(evaluateFilterTree(group([]), r, [labelField, qtyField])).toBe(true)
  })
  it('nested OR inside AND', () => {
    const tree = group([
      cond({ field_name: 'label', operator: 'is', value: 'apple' }),
      group([
        cond({ field_name: 'qty', operator: 'is', value: 1 }),
        cond({ field_name: 'qty', operator: 'is', value: 5 }),
      ], 'or'),
    ], 'and')
    expect(evaluateFilterTree(tree, r, [labelField, qtyField])).toBe(true)
  })
})

describe('filterTreeHasActiveCondition / countFilterConditions', () => {
  it('counts only active conditions', () => {
    const tree = group([
      cond({ operator: 'contains', value: 'x' }),       // active
      cond({ operator: 'contains', value: '' }),         // inactive
      cond({ field_name: 'qty', operator: 'isGreater', value: 0 }), // active
    ])
    expect(countFilterConditions(tree)).toBe(2)
    expect(filterTreeHasActiveCondition(tree)).toBe(true)
  })
  it('returns 0/false for null tree', () => {
    expect(countFilterConditions(null)).toBe(0)
    expect(filterTreeHasActiveCondition(null)).toBe(false)
  })
})

describe('parseFilterTree', () => {
  it('accepts a well-formed tree', () => {
    const raw = { kind: 'group', id: 'g', conjunction: 'and', children: [
      { kind: 'condition', id: 'c', field_name: 'label', operator: 'is', value: 'x' },
    ] }
    expect(parseFilterTree(raw)).toEqual(raw)
  })
  it('returns null when top node is not a group', () => {
    expect(parseFilterTree({ kind: 'condition', id: 'c', field_name: 'label', operator: 'is', value: 'x' })).toBeNull()
  })
  it('returns null when operator is unknown (e.g. legacy "equals")', () => {
    const raw = { kind: 'group', id: 'g', conjunction: 'and', children: [
      { kind: 'condition', id: 'c', field_name: 'label', operator: 'equals', value: 'x' },
    ] }
    expect(parseFilterTree(raw)).toBeNull()
  })
  it('returns null when raw is null/undefined/not-object', () => {
    expect(parseFilterTree(null)).toBeNull()
    expect(parseFilterTree(undefined)).toBeNull()
    expect(parseFilterTree('garbage')).toBeNull()
  })
  it('accepts nested groups', () => {
    const raw = {
      kind: 'group', id: 'g0', conjunction: 'and', children: [
        { kind: 'group', id: 'g1', conjunction: 'or', children: [
          { kind: 'condition', id: 'c', field_name: 'label', operator: 'is', value: 'x' },
        ] },
      ],
    }
    expect(parseFilterTree(raw)).toEqual(raw)
  })
})
