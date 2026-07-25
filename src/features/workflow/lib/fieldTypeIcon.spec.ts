import { describe, expect, it } from 'vitest'

import { fieldTypeIcon, fieldTypeLabel } from './fieldTypeIcon'

describe('fieldTypeIcon', () => {
  it('returns known icons', () => {
    expect(fieldTypeIcon('text')).toBe('T')
    expect(fieldTypeIcon('longtext')).toBe('¶')
    expect(fieldTypeIcon('number')).toBe('#')
    expect(fieldTypeIcon('date')).toBe('📅')
    expect(fieldTypeIcon('single_select')).toBe('◯')
    expect(fieldTypeIcon('attachment')).toBe('📎')
    expect(fieldTypeIcon('email')).toBe('@')
    expect(fieldTypeIcon('phone')).toBe('☏')
  })
  it('returns fallback for unknown', () => {
    expect(fieldTypeIcon('weird')).toBe('?')
  })
  it('returns labels for tooltip', () => {
    expect(fieldTypeLabel('text')).toBe('Text')
    expect(fieldTypeLabel('single_select')).toBe('Single Select')
  })
})
