import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountMock = vi.hoisted(() => ({
  current: { state: { status: 'credits_low' } },
}))
const diagnosticsMocks = vi.hoisted(() => ({
  collect: vi.fn(),
  copy: vi.fn(),
  format: vi.fn(),
}))
const openExternalURL = vi.hoisted(() => vi.fn())
const trackProductEvent = vi.hoisted(() => vi.fn())

vi.mock('@/features/account/hooks/useKitionAccount', () => ({
  useKitionAccount: () => accountMock.current,
}))

vi.mock('@/features/support/lib/supportDiagnostics', () => ({
  collectSupportDiagnostics: diagnosticsMocks.collect,
  copyTextToClipboard: diagnosticsMocks.copy,
  formatSupportDiagnostics: diagnosticsMocks.format,
}))

vi.mock('@/services/desktop', () => ({ openExternalURL }))
vi.mock('@/features/analytics/lib/productAnalytics', () => ({ trackProductEvent }))

import { SupportAndTrustSettings } from './SupportAndTrustSettings'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const props = {
  appVersion: '1.0.0-beta.3',
  appCommit: 'abc1234',
  buildIdentity: 'rc',
  builtAt: '2026-07-19T06:00:00Z',
  updateState: { phase: 'up-to-date' as const, currentVersion: '1.0.0-beta.3' },
}

let container: HTMLDivElement
let root: Root | null = null

function button(label: string) {
  return Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label)) as HTMLButtonElement
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(SupportAndTrustSettings, props))
    await Promise.resolve()
  })
}

beforeEach(() => {
  openExternalURL.mockReset()
  trackProductEvent.mockReset()
  diagnosticsMocks.collect.mockReset().mockResolvedValue({ schema: 'kition-support-diagnostics/v1' })
  diagnosticsMocks.format.mockReset().mockReturnValue('redacted diagnostics')
  diagnosticsMocks.copy.mockReset().mockResolvedValue(undefined)
  accountMock.current = { state: { status: 'credits_low' } }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
})

describe('SupportAndTrustSettings', () => {
  it('opens customer support, feedback, privacy, and terms destinations', async () => {
    await mount()

    await act(async () => {
      button('Contact support').click()
      button('Send feedback').click()
      button('Open Privacy Policy').click()
      button('Open Terms').click()
    })

    expect(openExternalURL.mock.calls).toEqual([
      ['mailto:support@kition.ai?subject=Kition%20Support'],
      ['mailto:support@kition.ai?subject=Kition%20Feedback'],
      ['https://kition.ai/privacy'],
      ['https://kition.ai/terms'],
    ])
    expect(trackProductEvent).toHaveBeenNthCalledWith(1, 'support_opened', { account_state: 'credits_low' })
    expect(trackProductEvent).toHaveBeenNthCalledWith(2, 'support_opened', { account_state: 'credits_low' })
  })

  it('passes account and update categories into a redacted diagnostics copy', async () => {
    await mount()

    await act(async () => {
      button('Copy diagnostics').click()
      await Promise.resolve()
    })

    expect(diagnosticsMocks.collect).toHaveBeenCalledWith({
      ...props,
      accountState: 'credits_low',
    })
    expect(diagnosticsMocks.format).toHaveBeenCalledWith({ schema: 'kition-support-diagnostics/v1' })
    expect(diagnosticsMocks.copy).toHaveBeenCalledWith('redacted diagnostics')
    expect(container.querySelector('[data-testid="support-diagnostics-feedback"]')?.textContent)
      .toContain('Redacted diagnostics copied')
  })

  it('shows a useful failure state when clipboard access is unavailable', async () => {
    diagnosticsMocks.copy.mockRejectedValueOnce(new Error('clipboard blocked'))
    await mount()

    await act(async () => {
      button('Copy diagnostics').click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="support-diagnostics-feedback"]')?.textContent)
      .toContain('Could not copy diagnostics')
  })
})
