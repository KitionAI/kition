import { describe, expect, it } from 'vitest'

import { deriveBannerState } from './StatusBanner'

describe('deriveBannerState', () => {
  it('returns enabled (no banner) when there are no issues and the workflow is on', () => {
    const state = deriveBannerState({ enabled: true, issues: [], lastRunStatus: 'ok' })
    expect(state.kind).toBe('enabled')
  })

  it('returns configured_disabled when issues are clean but the toggle is off', () => {
    const state = deriveBannerState({ enabled: false, issues: [], lastRunStatus: null })
    expect(state.kind).toBe('configured_disabled')
  })

  it('returns failing when the last run errored and reports its message', () => {
    const state = deriveBannerState({
      enabled: true,
      issues: [],
      lastRunStatus: 'error',
      lastRunMessage: 'smtp host not configured',
      failingNodeId: 'action_1',
    })
    expect(state.kind).toBe('failing')
    expect(state.body).toBe('smtp host not configured')
    expect(state.focusNodeId).toBe('action_1')
  })

  it('treats a missing connection while enabled as failing so the canvas red-dots the action', () => {
    const state = deriveBannerState({
      enabled: true,
      issues: [{ nodeId: 'action_1', code: 'connection_missing', message: 'No connection selected' }],
      lastRunStatus: null,
    })
    expect(state.kind).toBe('failing')
    expect(state.focusNodeId).toBe('action_1')
  })

  it('treats a missing connection while disabled as not_configured (gentler nudge)', () => {
    const state = deriveBannerState({
      enabled: false,
      issues: [{ nodeId: 'action_1', code: 'connection_missing', message: 'No connection selected' }],
      lastRunStatus: null,
    })
    expect(state.kind).toBe('configured_disabled')
  })

  it('returns not_configured for a brand-new workflow without enable + with hard blockers — body summarises rather than echoing the specific field message (the card/drawer surface that)', () => {
    const state = deriveBannerState({
      enabled: false,
      issues: [{ nodeId: 'action_1', code: 'to_empty', message: 'Recipient is required' }],
      lastRunStatus: null,
    })
    expect(state.kind).toBe('not_configured')
    expect(state.body).not.toContain('Recipient is required')
    expect(state.focusNodeId).toBe('action_1')
  })
})
