import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  completeWorkspaceOnboarding,
  markWorkspaceOnboardingPending,
  readWorkspaceOnboardingState,
  shouldShowWorkspaceOnboarding,
  skipWorkspaceOnboarding,
} from './onboardingState'

describe('workspace onboarding state', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T06:00:00Z'))
  })

  it('stores pending state per workspace without exposing the workspace path', () => {
    markWorkspaceOnboardingPending('/Users/member/Private Workspace')

    expect(shouldShowWorkspaceOnboarding('/Users/member/Private Workspace')).toBe(true)
    expect(shouldShowWorkspaceOnboarding('/Users/member/Other Workspace')).toBe(false)
    expect(JSON.stringify(localStorage)).not.toContain('Private Workspace')
  })

  it('records completion and provider choice', () => {
    markWorkspaceOnboardingPending('/workspace/a')
    completeWorkspaceOnboarding('/workspace/a', 'local')

    expect(readWorkspaceOnboardingState('/workspace/a')).toEqual({
      version: 1,
      status: 'completed',
      providerChoice: 'local',
      updatedAt: '2026-07-19T06:00:00.000Z',
    })
    expect(shouldShowWorkspaceOnboarding('/workspace/a')).toBe(false)
  })

  it('does not revive a completed workspace when pending is requested again', () => {
    completeWorkspaceOnboarding('/workspace/a', 'cloud')
    markWorkspaceOnboardingPending('/workspace/a')

    expect(readWorkspaceOnboardingState('/workspace/a')?.status).toBe('completed')
  })

  it('persists skip as a non-repeating decision', () => {
    markWorkspaceOnboardingPending('/workspace/a')
    skipWorkspaceOnboarding('/workspace/a')

    expect(readWorkspaceOnboardingState('/workspace/a')?.status).toBe('skipped')
    expect(shouldShowWorkspaceOnboarding('/workspace/a')).toBe(false)
  })
})
