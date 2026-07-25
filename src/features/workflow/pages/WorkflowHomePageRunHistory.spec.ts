import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatAbsoluteTime, relativeTime } from './WorkflowHomePageRunHistory'

describe('relativeTime', () => {
  beforeEach(() => {
    // Pin the clock so "5m ago" tests stay deterministic. We rebase Date.now
    // to 2026-01-15 12:00:00 UTC for the duration of the suite.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "" for an empty input so the row title slot stays clean', () => {
    expect(relativeTime('')).toBe('')
  })

  it('passes through invalid ISO strings unchanged rather than crashing', () => {
    expect(relativeTime('not-a-date')).toBe('not-a-date')
  })

  it('returns "just now" for instants in the most recent minute', () => {
    expect(relativeTime('2026-01-15T11:59:30Z')).toBe('just now')
  })

  it('returns minutes-ago for instants in the same hour', () => {
    expect(relativeTime('2026-01-15T11:55:00Z')).toBe('5m ago')
    expect(relativeTime('2026-01-15T11:01:00Z')).toBe('59m ago')
  })

  it('returns hours-ago for instants in the same day', () => {
    expect(relativeTime('2026-01-15T09:00:00Z')).toBe('3h ago')
  })

  it('returns days-ago for instants within the last week', () => {
    expect(relativeTime('2026-01-13T12:00:00Z')).toBe('2d ago')
  })

  it('falls back to a date for instants older than a week', () => {
    // We don't pin a locale here — toLocaleDateString format varies by runtime.
    // Just assert the function picked the date path (no "ago" suffix).
    expect(relativeTime('2026-01-01T12:00:00Z')).not.toMatch(/ago/)
  })

  it('renders future instants as a full datetime label, not negative-ago', () => {
    expect(relativeTime('2026-02-01T12:00:00Z')).not.toMatch(/ago/)
  })
})

describe('formatAbsoluteTime', () => {
  it('returns "" for empty input', () => {
    expect(formatAbsoluteTime('')).toBe('')
  })

  it('passes through invalid ISO strings unchanged', () => {
    expect(formatAbsoluteTime('not-a-date')).toBe('not-a-date')
  })

  it('renders a non-empty localised string for a valid timestamp', () => {
    // The exact format depends on Intl; just assert it parsed and produced
    // something substantive (year + some delimiter).
    const got = formatAbsoluteTime('2026-01-15T12:00:00Z')
    expect(got.length).toBeGreaterThan(8)
    expect(got).toMatch(/2026/)
  })
})
