import { describe, expect, it } from 'vitest'
import type { DataField } from '@/types/dataDocument'
import { getOperatorLabel, getOperatorsForField, isFieldFilterable } from './operators'

function field(type: DataField['type']): DataField {
  return {
    id: 1, user_id: 1, document_id: 1, table_id: 1,
    name: 'f', title: 'F', type,
    required: false, unique: false, readonly: false, is_primary: false,
    order: 0,
    options: null, ai_config: null,
    created_at: '', updated_at: '',
  }
}

describe('getOperatorsForField', () => {
  it('text fields offer text operators in display order', () => {
    expect(getOperatorsForField(field('text'))).toEqual([
      'is', 'isNot', 'contains', 'doesNotContain', 'isEmpty', 'isNotEmpty',
    ])
  })

  it('long_text and url share text operators', () => {
    expect(getOperatorsForField(field('long_text'))).toEqual(getOperatorsForField(field('text')))
    expect(getOperatorsForField(field('url'))).toEqual(getOperatorsForField(field('text')))
  })

  it('number / rating / auto_number share number operators', () => {
    const expected = ['is', 'isNot', 'isGreater', 'isGreaterEqual', 'isLess', 'isLessEqual', 'isEmpty', 'isNotEmpty']
    expect(getOperatorsForField(field('number'))).toEqual(expected)
    expect(getOperatorsForField(field('rating'))).toEqual(expected)
    expect(getOperatorsForField(field('auto_number'))).toEqual(expected)
  })

  it('date / datetime / created_time / last_modified_time share date operators', () => {
    const expected = ['is', 'isNot', 'isWithIn', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isEmpty', 'isNotEmpty']
    expect(getOperatorsForField(field('date'))).toEqual(expected)
    expect(getOperatorsForField(field('datetime'))).toEqual(expected)
    expect(getOperatorsForField(field('created_time'))).toEqual(expected)
    expect(getOperatorsForField(field('last_modified_time'))).toEqual(expected)
  })

  it('single_select offers is/isNot/isAnyOf/isNoneOf/isEmpty/isNotEmpty', () => {
    expect(getOperatorsForField(field('single_select'))).toEqual([
      'is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty',
    ])
  })

  it('multi_select offers hasAnyOf/hasAllOf/isExactly/isNotExactly/hasNoneOf/isEmpty/isNotEmpty', () => {
    expect(getOperatorsForField(field('multi_select'))).toEqual([
      'hasAnyOf', 'hasAllOf', 'isExactly', 'isNotExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty',
    ])
  })

  it('checkbox offers only is', () => {
    expect(getOperatorsForField(field('checkbox'))).toEqual(['is'])
  })

  it('user / created_by / last_modified_by share user operators', () => {
    const expected = ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty']
    expect(getOperatorsForField(field('user'))).toEqual(expected)
    expect(getOperatorsForField(field('created_by'))).toEqual(expected)
    expect(getOperatorsForField(field('last_modified_by'))).toEqual(expected)
  })

  it('attachment offers only isEmpty/isNotEmpty', () => {
    expect(getOperatorsForField(field('attachment'))).toEqual(['isEmpty', 'isNotEmpty'])
  })

  it('hidden field types return empty operator list', () => {
    for (const t of ['document_link', 'link_to_record', 'lookup', 'rollup', 'formula', 'button'] as const) {
      expect(getOperatorsForField(field(t))).toEqual([])
    }
  })
})

describe('isFieldFilterable', () => {
  it('is true for filterable types', () => {
    expect(isFieldFilterable(field('text'))).toBe(true)
    expect(isFieldFilterable(field('multi_select'))).toBe(true)
  })

  it('is false for hidden types', () => {
    expect(isFieldFilterable(field('document_link'))).toBe(false)
    expect(isFieldFilterable(field('formula'))).toBe(false)
  })
})

describe('getOperatorLabel', () => {
  it('returns the human label for every operator', () => {
    expect(getOperatorLabel('is')).toBe('is')
    expect(getOperatorLabel('isNot')).toBe('is not')
    expect(getOperatorLabel('contains')).toBe('contains')
    expect(getOperatorLabel('doesNotContain')).toBe('does not contain')
    expect(getOperatorLabel('isEmpty')).toBe('is empty')
    expect(getOperatorLabel('isNotEmpty')).toBe('is not empty')
    expect(getOperatorLabel('isGreater')).toBe('>')
    expect(getOperatorLabel('isGreaterEqual')).toBe('≥')
    expect(getOperatorLabel('isLess')).toBe('<')
    expect(getOperatorLabel('isLessEqual')).toBe('≤')
    expect(getOperatorLabel('isAnyOf')).toBe('is any of')
    expect(getOperatorLabel('isNoneOf')).toBe('is none of')
    expect(getOperatorLabel('hasAnyOf')).toBe('has any of')
    expect(getOperatorLabel('hasAllOf')).toBe('has all of')
    expect(getOperatorLabel('isExactly')).toBe('is exactly')
    expect(getOperatorLabel('isNotExactly')).toBe('is not exactly')
    expect(getOperatorLabel('hasNoneOf')).toBe('has none of')
    expect(getOperatorLabel('isWithIn')).toBe('is within')
    expect(getOperatorLabel('isBefore')).toBe('is before')
    expect(getOperatorLabel('isAfter')).toBe('is after')
    expect(getOperatorLabel('isOnOrBefore')).toBe('is on or before')
    expect(getOperatorLabel('isOnOrAfter')).toBe('is on or after')
  })
})
