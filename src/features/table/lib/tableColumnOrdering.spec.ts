import { describe, expect, it } from 'vitest'

import type { DataField } from '@/types/dataDocument'

import { reorderTableFields } from './tableColumnOrdering'

function makeField(id: number, order: number): DataField {
  return {
    id,
    user_id: 1,
    document_id: 1,
    table_id: 1,
    name: `field_${id}`,
    title: `Field ${id}`,
    type: 'text',
    required: false,
    unique: false,
    readonly: false,
    is_primary: id === 1,
    order,
    options: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

describe('reorderTableFields', () => {
  it('moves a visible field to the requested insertion point', () => {
    const fields = [makeField(1, 0), makeField(2, 1), makeField(3, 2)]

    const reordered = reorderTableFields(fields, fields, 1, 3)

    expect(reordered.map((field) => field.id)).toEqual([2, 3, 1])
    expect(reordered.map((field) => field.order)).toEqual([0, 1, 2])
  })

  it('keeps hidden fields in place while reordering visible columns', () => {
    const fields = [
      makeField(1, 10),
      makeField(2, 20),
      makeField(3, 30),
      makeField(4, 40),
    ]
    const visibleFields = [fields[0], fields[2], fields[3]]

    const reordered = reorderTableFields(fields, visibleFields, 4, 0)

    expect(reordered.map((field) => field.id)).toEqual([4, 2, 1, 3])
    expect(reordered.map((field) => field.order)).toEqual([10, 20, 30, 40])
  })

  it('returns the original array for a no-op drop', () => {
    const fields = [makeField(1, 0), makeField(2, 1)]

    expect(reorderTableFields(fields, fields, 1, 1)).toBe(fields)
  })
})
