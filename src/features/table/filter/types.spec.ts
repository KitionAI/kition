import { describe, expect, it } from 'vitest'
import {
  createEmptyFilterCondition,
  createEmptyFilterGroup,
  type FilterCondition,
  type FilterGroup,
} from './types'

describe('createEmptyFilterCondition', () => {
  it('returns a condition with default operator "is" and null value', () => {
    const cond: FilterCondition = createEmptyFilterCondition()
    expect(cond.kind).toBe('condition')
    expect(cond.field_name).toBe('')
    expect(cond.operator).toBe('is')
    expect(cond.value).toBeNull()
    expect(cond.id).toMatch(/^cond_/)
  })
})

describe('createEmptyFilterGroup', () => {
  it('defaults to AND conjunction with a single empty condition child', () => {
    const grp: FilterGroup = createEmptyFilterGroup()
    expect(grp.kind).toBe('group')
    expect(grp.conjunction).toBe('and')
    expect(grp.children).toHaveLength(1)
    expect(grp.children[0]!.kind).toBe('condition')
    expect(grp.id).toMatch(/^grp_/)
  })

  it('honours an explicit OR conjunction', () => {
    expect(createEmptyFilterGroup('or').conjunction).toBe('or')
  })
})
