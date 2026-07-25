import { describe, expect, it } from 'vitest'
import type { DataField } from '@/types/dataDocument'
import { coerceConditionOnChange } from './coerce'
import type { FilterCondition } from './types'

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

const textField = field('label', 'text')
const numberField = field('qty', 'number')
const singleSelectField = field('stage', 'single_select')

const baseCond = (overrides: Partial<FilterCondition> = {}): FilterCondition => ({
  id: 'c1',
  kind: 'condition',
  field_name: 'label',
  operator: 'is',
  value: 'foo',
  ...overrides,
})

describe('coerceConditionOnChange — field change', () => {
  it('resets operator to first allowed of new field and clears value', () => {
    const prev = baseCond()
    const next = coerceConditionOnChange(prev, { field_name: 'qty' }, [textField, numberField])
    expect(next.field_name).toBe('qty')
    expect(next.operator).toBe('is')
    expect(next.value).toBeNull()
  })

  it('clears operator to "is" fallback when field is unknown', () => {
    const prev = baseCond()
    const next = coerceConditionOnChange(prev, { field_name: 'missing' }, [textField])
    expect(next.field_name).toBe('missing')
    expect(next.operator).toBe('is')
    expect(next.value).toBeNull()
  })
})

describe('coerceConditionOnChange — operator change', () => {
  it('switches to isEmpty -> clears value to null', () => {
    const prev = baseCond({ value: 'foo' })
    const next = coerceConditionOnChange(prev, { operator: 'isEmpty' }, [textField])
    expect(next.operator).toBe('isEmpty')
    expect(next.value).toBeNull()
  })

  it('switches from is to isNot -> keeps scalar value', () => {
    const prev = baseCond({ value: 'foo' })
    const next = coerceConditionOnChange(prev, { operator: 'isNot' }, [textField])
    expect(next.value).toBe('foo')
  })

  it('switches single_select from is to isAnyOf -> wraps scalar value in array', () => {
    const prev: FilterCondition = baseCond({ field_name: 'stage', operator: 'is', value: 'todo' })
    const next = coerceConditionOnChange(prev, { operator: 'isAnyOf' }, [singleSelectField])
    expect(next.value).toEqual(['todo'])
  })

  it('switches single_select from isAnyOf to is -> takes first array element', () => {
    const prev: FilterCondition = baseCond({ field_name: 'stage', operator: 'isAnyOf', value: ['a', 'b'] })
    const next = coerceConditionOnChange(prev, { operator: 'is' }, [singleSelectField])
    expect(next.value).toBe('a')
  })

  it('switches single_select from isAnyOf to is with empty array -> null value', () => {
    const prev: FilterCondition = baseCond({ field_name: 'stage', operator: 'isAnyOf', value: [] })
    const next = coerceConditionOnChange(prev, { operator: 'is' }, [singleSelectField])
    expect(next.value).toBeNull()
  })

  it('switches single_select from is with null value to isAnyOf -> empty array', () => {
    const prev: FilterCondition = baseCond({ field_name: 'stage', operator: 'is', value: null })
    const next = coerceConditionOnChange(prev, { operator: 'isAnyOf' }, [singleSelectField])
    expect(next.value).toEqual([])
  })
})

describe('coerceConditionOnChange — value passthrough', () => {
  it('updates only the value when value is the only change', () => {
    const prev = baseCond({ value: 'foo' })
    const next = coerceConditionOnChange(prev, { value: 'bar' }, [textField])
    expect(next.value).toBe('bar')
    expect(next.operator).toBe('is')
    expect(next.field_name).toBe('label')
  })
})
