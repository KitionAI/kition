import { describe, expect, it } from 'vitest'

import type { DataField, DataRecord } from '@/types/dataDocument'
import type { IGroupRowPoint } from '@/features/table/grid/interface'

import {
  buildGroupCollection,
  buildGroupId,
  buildGroupPoints,
  compareRecordValues,
  displayValue,
  getSortDirectionLabels,
  normalizeLegacyViewTitle,
  recordMatchesSearch,
} from './tableEditorShared'

function makeField(overrides: Partial<DataField>): DataField {
  return {
    id: overrides.id ?? 1,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    name: overrides.name ?? 'name',
    title: overrides.title ?? overrides.name ?? 'Name',
    type: overrides.type ?? 'text',
    required: false,
    unique: false,
    readonly: false,
    is_primary: false,
    order: 0,
    options: overrides.options ?? null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as DataField
}

function makeRecord(id: number, values: Record<string, any>): DataRecord {
  return {
    id,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    row_key: `row_${id}`,
    order: id,
    values,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as DataRecord
}

describe('normalizeLegacyViewTitle', () => {
  it('maps the included task table legacy grid title to Grid view', () => {
    expect(normalizeLegacyViewTitle({ title: 'All tasks', type: 'grid' })).toBe('Grid view')
    expect(normalizeLegacyViewTitle({ title: 'All messages', type: 'grid' })).toBe('Grid view')
  })

  it('preserves user-defined view titles', () => {
    expect(normalizeLegacyViewTitle({ title: 'My tasks', type: 'grid' })).toBe('My tasks')
    expect(normalizeLegacyViewTitle({ title: 'All tasks', type: 'kanban' })).toBe('All tasks')
  })
})

describe('displayValue — phase 2 ref shapes', () => {
  it('extracts LinkRef.display so filter/sort/search/group see link cells as text', () => {
    expect(displayValue({ row_key: 'r_1', display: 'Project Alpha' })).toBe('Project Alpha')
    expect(displayValue([{ row_key: 'r_1', display: 'Alpha' }, { row_key: 'r_2', display: 'Beta' }])).toBe(
      'Alpha, Beta',
    )
  })

  it('falls back to row_key when LinkRef has no display label', () => {
    expect(displayValue({ row_key: 'r_999' })).toBe('r_999')
  })

  it('extracts UserRef.name', () => {
    expect(displayValue([{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }])).toBe('Alice, Bob')
  })

  it('returns empty string for an empty link/user array', () => {
    expect(displayValue([])).toBe('')
  })
})

describe('compareRecordValues (multi-sort building block)', () => {
  it('ascending text', () => {
    expect(compareRecordValues('apple', 'banana', 'asc')).toBeLessThan(0)
    expect(compareRecordValues('banana', 'apple', 'asc')).toBeGreaterThan(0)
    expect(compareRecordValues('apple', 'apple', 'asc')).toBe(0)
  })

  it('descending text', () => {
    expect(compareRecordValues('apple', 'banana', 'desc')).toBeGreaterThan(0)
  })

  it('numeric comparison via numeric: true locale', () => {
    expect(compareRecordValues(2, 10, 'asc')).toBeLessThan(0)
    expect(compareRecordValues(10, 2, 'asc')).toBeGreaterThan(0)
  })
})

describe('recordMatchesSearch (table-wide search)', () => {
  const fields = [
    makeField({ id: 1, name: 'name', type: 'text' }),
    makeField({ id: 2, name: 'tags', type: 'multi_select' }),
  ]

  it('empty query matches every record', () => {
    expect(recordMatchesSearch(makeRecord(1, { name: 'X' }), fields, '')).toBe(true)
    expect(recordMatchesSearch(makeRecord(1, { name: 'X' }), fields, '   ')).toBe(true)
  })

  it('matches text in any field case-insensitively', () => {
    const rec = makeRecord(1, { name: 'Project Apollo', tags: ['urgent'] })
    expect(recordMatchesSearch(rec, fields, 'apollo')).toBe(true)
    expect(recordMatchesSearch(rec, fields, 'URGENT')).toBe(true)
    expect(recordMatchesSearch(rec, fields, 'zeta')).toBe(false)
  })
})

describe('buildGroupId', () => {
  it('joins ancestor key values with depth-prefixed JSON', () => {
    expect(buildGroupId(['Done'])).toBe('g0:"Done"')
    expect(buildGroupId(['Done', 'Alice'])).toBe('g0:"Done"::g1:"Alice"')
  })

  it('uses null when value is null/undefined', () => {
    expect(buildGroupId([null])).toBe('g0:null')
    expect(buildGroupId([undefined as unknown])).toBe('g0:null')
  })

  it('distinguishes same leaf value under different parents', () => {
    expect(buildGroupId(['Done', 'Alice'])).not.toBe(buildGroupId(['Todo', 'Alice']))
  })
})

describe('buildGroupPoints', () => {
  const item = (field_name: string) => ({
    id: `g:${field_name}`,
    field_name,
    direction: 'asc' as const,
  })

  const rec = (id: number, values: Record<string, unknown>) =>
    ({ id, values } as unknown as DataRecord)

  it('returns empty array when there are no records', () => {
    expect(buildGroupPoints([], [item('status')], new Set())).toEqual([])
  })

  it('returns empty array when there are no group items', () => {
    expect(buildGroupPoints([rec(1, { status: 'Done' })], [], new Set())).toEqual([])
  })

  it('emits one header + one row-block for a single group of contiguous rows', () => {
    const records = [
      rec(1, { status: 'Done' }),
      rec(2, { status: 'Done' }),
      rec(3, { status: 'Done' }),
    ]
    const result = buildGroupPoints(records, [item('status')], new Set())
    expect(result).toEqual([
      { id: 'g0:"Done"', type: 0 /* LinearRowType.Group */, depth: 0, value: 'Done', isCollapsed: false },
      { type: 1 /* LinearRowType.Row */, count: 3 },
    ])
  })

  it('emits a new depth-0 header each time the top-level key changes', () => {
    const records = [
      rec(1, { status: 'Done' }),
      rec(2, { status: 'Todo' }),
      rec(3, { status: 'Todo' }),
    ]
    const result = buildGroupPoints(records, [item('status')], new Set())
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ depth: 0, value: 'Done' })
    expect(result[1]).toEqual({ type: 1, count: 1 })
    expect(result[2]).toMatchObject({ depth: 0, value: 'Todo' })
    expect(result[3]).toEqual({ type: 1, count: 2 })
  })

  it('nests depth-1 headers under depth-0 headers (two-level grouping)', () => {
    const records = [
      rec(1, { status: 'Done', owner: 'Alice' }),
      rec(2, { status: 'Done', owner: 'Bob' }),
      rec(3, { status: 'Todo', owner: 'Alice' }),
    ]
    const result = buildGroupPoints(records, [item('status'), item('owner')], new Set())
    expect(result.map((p) => ('depth' in p ? `H${p.depth}:${String(p.value)}` : `R${(p as IGroupRowPoint).count}`))).toEqual([
      'H0:Done',
      'H1:Alice',
      'R1',
      'H1:Bob',
      'R1',
      'H0:Todo',
      'H1:Alice',
      'R1',
    ])
  })

  it('uses null as the value when the field is missing/null', () => {
    const records = [rec(1, {}), rec(2, { status: null })]
    const result = buildGroupPoints(records, [item('status')], new Set())
    expect(result[0]).toMatchObject({ depth: 0, value: null })
    expect(result[1]).toEqual({ type: 1, count: 2 })
  })

  it('marks isCollapsed=true on headers whose id is in collapsedIds', () => {
    const records = [rec(1, { status: 'Done' })]
    const collapsed = new Set(['g0:"Done"'])
    const result = buildGroupPoints(records, [item('status')], collapsed)
    expect(result[0]).toMatchObject({ isCollapsed: true })
  })
})

describe('buildGroupCollection', () => {
  const field = (name: string, title: string): DataField =>
    ({ id: 1, name, title, type: 'single_select', readonly: false, is_primary: false } as unknown as DataField)

  const item = (field_name: string) => ({
    id: `g:${field_name}`,
    field_name,
    direction: 'asc' as const,
  })

  it('emits one column per group item, using the field title when known', () => {
    const collection = buildGroupCollection(
      [item('status'), item('owner')],
      [field('status', 'Status'), field('owner', 'Owner')],
    )
    expect(collection.groupColumns).toHaveLength(2)
    expect(collection.groupColumns[0].name).toBe('Status')
    expect(collection.groupColumns[1].name).toBe('Owner')
  })

  it('falls back to field_name when no matching field is found', () => {
    const collection = buildGroupCollection([item('ghost')], [])
    expect(collection.groupColumns[0].name).toBe('ghost')
  })

  it('renders a Text cell with the displayValue, falling back to "Empty"', () => {
    const collection = buildGroupCollection([item('status')], [field('status', 'Status')])
    const cell = collection.getGroupCell('Done', 0)
    expect(cell).toMatchObject({ type: 'Text', data: 'Done', displayData: 'Done' })

    const emptyCell = collection.getGroupCell(null, 0)
    expect(emptyCell).toMatchObject({ type: 'Text', data: 'Empty', displayData: 'Empty' })
  })
})

describe('getSortDirectionLabels', () => {
  it('returns A → Z / Z → A for text-group fields', () => {
    expect(getSortDirectionLabels('text')).toEqual({ asc: 'A → Z', desc: 'Z → A' })
    expect(getSortDirectionLabels('long_text')).toEqual({ asc: 'A → Z', desc: 'Z → A' })
    expect(getSortDirectionLabels('url')).toEqual({ asc: 'A → Z', desc: 'Z → A' })
    expect(getSortDirectionLabels('single_select')).toEqual({ asc: 'A → Z', desc: 'Z → A' })
  })

  it('returns 1 → 9 / 9 → 1 for number-group fields', () => {
    expect(getSortDirectionLabels('number')).toEqual({ asc: '1 → 9', desc: '9 → 1' })
    expect(getSortDirectionLabels('rating')).toEqual({ asc: '1 → 9', desc: '9 → 1' })
    expect(getSortDirectionLabels('auto_number')).toEqual({ asc: '1 → 9', desc: '9 → 1' })
  })

  it('returns Earliest → Latest for date-group fields', () => {
    expect(getSortDirectionLabels('date')).toEqual({
      asc: 'Earliest → Latest',
      desc: 'Latest → Earliest',
    })
    expect(getSortDirectionLabels('datetime')).toEqual({
      asc: 'Earliest → Latest',
      desc: 'Latest → Earliest',
    })
    expect(getSortDirectionLabels('created_time')).toEqual({
      asc: 'Earliest → Latest',
      desc: 'Latest → Earliest',
    })
    expect(getSortDirectionLabels('last_modified_time')).toEqual({
      asc: 'Earliest → Latest',
      desc: 'Latest → Earliest',
    })
  })

  it('returns Unchecked → Checked for checkbox', () => {
    expect(getSortDirectionLabels('checkbox')).toEqual({
      asc: 'Unchecked → Checked',
      desc: 'Checked → Unchecked',
    })
  })

  it('falls back to Ascending / Descending for non-orderable / multi-value fields', () => {
    expect(getSortDirectionLabels('multi_select')).toEqual({
      asc: 'Ascending',
      desc: 'Descending',
    })
    expect(getSortDirectionLabels('attachment')).toEqual({
      asc: 'Ascending',
      desc: 'Descending',
    })
    expect(getSortDirectionLabels('user')).toEqual({
      asc: 'Ascending',
      desc: 'Descending',
    })
    expect(getSortDirectionLabels('formula')).toEqual({
      asc: 'Ascending',
      desc: 'Descending',
    })
  })
})
