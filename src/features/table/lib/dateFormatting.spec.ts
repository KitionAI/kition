import { describe, expect, it } from 'vitest'

import {
  formatTableFieldValue,
  fromDateInputValue,
  toDateInputValue,
} from './dateFormatting'

describe('formatTableFieldValue', () => {
  it('formats date-only values without changing the calendar day', () => {
    expect(formatTableFieldValue({ type: 'date' }, '2026-07-23')).toBe('2026/07/23')
  })

  it('formats ISO timestamps as 24-hour date and time values', () => {
    const value = '2026-07-23T04:14:47Z'
    const formatted = formatTableFieldValue({ type: 'datetime' }, value)

    expect(formatted).not.toBe(value)
    expect(formatted).toMatch(/^2026\/\d{2}\/\d{2} \d{2}:\d{2}$/)
  })

  it('uses the configured date format and optional timezone suffix', () => {
    const value = '2026-07-23T04:14:47Z'

    expect(formatTableFieldValue({
      type: 'datetime',
      options: { date_format: 'year_month_day_time_zone_dash' },
    }, value)).toMatch(/^2026-\d{2}-\d{2} \d{2}:\d{2} \(GMT[+-]\d{1,2}(?::\d{2})?\)$/)
    expect(formatTableFieldValue({
      type: 'datetime',
      options: { date_format: 'day_month_year_slash' },
    }, value)).toMatch(/^\d{2}\/\d{2}\/2026$/)
  })

  it('keeps invalid date values visible instead of normalizing them', () => {
    expect(formatTableFieldValue({ type: 'date' }, '2026-02-30')).toBe('2026-02-30')
    expect(formatTableFieldValue({ type: 'datetime' }, 'not-a-date')).toBe('not-a-date')
  })

  it('leaves non-date field values unchanged', () => {
    expect(formatTableFieldValue({ type: 'text' }, '2026-07-23T04:14:47Z')).toBe(
      '2026-07-23T04:14:47Z',
    )
  })

  it('converts stored timestamps to native editor values and back', () => {
    const stored = '2026-07-23T04:14:47Z'
    const editorValue = toDateInputValue('datetime-local', stored)
    const saved = fromDateInputValue('datetime-local', editorValue)

    expect(editorValue).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:47$/)
    expect(new Date(saved).getTime()).toBe(new Date(stored).getTime())
    expect(toDateInputValue('date', '2026-07-23')).toBe('2026-07-23')
  })
})
