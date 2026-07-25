import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountMock = vi.hoisted(() => ({ current: {} as any }))
const openExternalURL = vi.hoisted(() => vi.fn())
const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
  trackOnce: vi.fn(),
}))

vi.mock('@/features/account/hooks/useKitionAccount', () => ({
  useKitionAccount: () => accountMock.current,
}))

vi.mock('@/services/desktop', () => ({ openExternalURL }))
vi.mock('@/features/analytics/lib/productAnalytics', () => ({
  trackProductEvent: analyticsMocks.track,
  trackProductEventOnce: analyticsMocks.trackOnce,
}))

import { KitionAccountPanel } from './KitionAccountPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(KitionAccountPanel))
    await Promise.resolve()
  })
}

function baseAccount(status: string, session: Record<string, unknown> | null = null) {
  return {
    state: { status, session, errorMessage: '' },
    ensureReady: vi.fn().mockResolvedValue(session),
    cancelConnect: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(session),
  }
}

beforeEach(() => {
  openExternalURL.mockReset()
  analyticsMocks.track.mockReset()
  analyticsMocks.trackOnce.mockReset()
  accountMock.current = baseAccount('signed_out')
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
})

describe('KitionAccountPanel', () => {
  it('explains hosted benefits before sign-in', async () => {
    await mount()

    expect(container.textContent).toContain('Use Kition Cloud models')
    expect(container.textContent).toContain('No separate API key required')
    expect(container.querySelector('[data-testid="portal-account-button"]')).not.toBeNull()
    expect(container.querySelector('.kition-account-panel__icon img')?.getAttribute('src')).toContain('logo-mark.png')
  })

  it.each([
    ['loading', 'Checking account', true],
    ['expired', 'Sign in again', false],
    ['temporary_error', 'Try again', false],
  ])('shows the correct recovery action for %s', async (status, label, disabled) => {
    accountMock.current = baseAccount(status)
    await mount()

    const button = container.querySelector('[data-testid="portal-account-button"]') as HTMLButtonElement
    expect(button.textContent).toContain(label)
    expect(button.disabled).toBe(disabled)
    expect(container.querySelector('[data-account-status]')?.getAttribute('data-account-status')).toBe(status)
  })

  it('shows plan, subscription, and separate credit balances', async () => {
    accountMock.current = baseAccount('ready', {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      plan_display_name: 'Founders Plan',
      subscription_status: 'active',
      credit_total: 150,
      credit_balance: 87,
      period_credit_total: 100,
      period_credit_balance: 60,
      wallet_credit_total: 50,
      wallet_credit_balance: 27,
    })
    await mount()

    expect(container.textContent).toContain('member@kition.ai')
    expect(container.textContent).toContain('Founders Plan')
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('Plan credits')
    expect(container.textContent).toContain('60 / 100')
    expect(container.textContent).toContain('Purchased credits')
    expect(container.textContent).toContain('27 / 50')
    expect(container.querySelector('[data-testid="kition-account-manage-plan"]')).not.toBeNull()
  })

  it.each([
    ['active', 'is-active'],
    ['trialing', 'is-trial'],
    ['past_due', 'is-payment_required'],
    ['canceled', 'is-canceled'],
  ])('gives the %s subscription a distinct semantic badge', async (subscriptionStatus, className) => {
    accountMock.current = baseAccount('ready', {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      subscription_status: subscriptionStatus,
    })
    await mount()

    expect(container.querySelector('.kition-account-status-badge')?.classList.contains(className)).toBe(true)
  })

  it('keeps low-credit accounts usable while making top-up prominent', async () => {
    accountMock.current = baseAccount('credits_low', {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      credit_total: 100,
      credit_balance: 20,
      topup_url: 'https://billing.kition.ai/topup',
    })
    await mount()

    expect(container.textContent).toContain('Your credits are running low.')
    expect(container.querySelector('[data-testid="kition-account-topup"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="portal-account-logout-button"]')).not.toBeNull()
    expect(analyticsMocks.trackOnce).toHaveBeenCalledWith('credits_low_seen', { account_state: 'credits_low' })
  })

  it('makes top-up the primary recovery action when credits are empty', async () => {
    accountMock.current = baseAccount('credits_empty', {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      credit_total: 100,
      credit_balance: 0,
      topup_url: 'https://billing.kition.ai/topup',
    })
    await mount()

    const topup = container.querySelector('[data-testid="kition-account-topup"]') as HTMLButtonElement
    expect(topup.textContent).toContain('Top up credits')
    await act(async () => {
      topup.click()
    })
    expect(openExternalURL).toHaveBeenCalledWith('https://billing.kition.ai/topup')
    expect(analyticsMocks.track).toHaveBeenCalledWith('billing_opened', {
      result: 'success',
      account_state: 'credits_empty',
    })
  })

  it('refreshes account state when focus returns from billing', async () => {
    accountMock.current = baseAccount('ready', {
      access_token: 'token',
      token_prefix: 'prefix',
      user_id: 7,
      user_email: 'member@kition.ai',
      expires_at: '2026-08-01T00:00:00Z',
      billing_url: 'https://billing.kition.ai/manage',
    })
    await mount()

    await act(async () => {
      const managePlan = container.querySelector('[data-testid="kition-account-manage-plan"]') as HTMLButtonElement
      managePlan.click()
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(openExternalURL).toHaveBeenCalledWith('https://billing.kition.ai/manage')
    expect(accountMock.current.refresh).toHaveBeenCalledTimes(1)
  })

  it('offers cancellation while browser sign-in is pending', async () => {
    accountMock.current = baseAccount('connecting')
    await mount()

    const button = container.querySelector('[data-testid="portal-account-button"]') as HTMLButtonElement
    expect(button.textContent).toContain('Cancel sign-in')
    await act(async () => {
      button.click()
    })
    expect(accountMock.current.cancelConnect).toHaveBeenCalledTimes(1)
  })
})
