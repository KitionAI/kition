import { beforeEach, describe, expect, it } from 'vitest'
import { dismissVersion, isVersionDismissed, clearDismissedVersion } from './dismissedVersion'

describe('dismissedVersion', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('returns false when nothing dismissed', () => {
    expect(isVersionDismissed('1.0.1')).toBe(false)
  })

  it('records and reports dismissal for a specific version', () => {
    dismissVersion('1.0.1')
    expect(isVersionDismissed('1.0.1')).toBe(true)
    expect(isVersionDismissed('1.0.2')).toBe(false)
  })

  it('clearDismissedVersion forgets the dismissal', () => {
    dismissVersion('1.0.1')
    clearDismissedVersion()
    expect(isVersionDismissed('1.0.1')).toBe(false)
  })

  it('handles empty/undefined versions safely', () => {
    expect(isVersionDismissed('')).toBe(false)
    expect(isVersionDismissed(undefined as any)).toBe(false)
    dismissVersion('')
    expect(isVersionDismissed('')).toBe(false)
  })
})
