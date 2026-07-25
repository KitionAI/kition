import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PortalAccountSession } from '@/api/desktop'

const mocks = vi.hoisted(() => ({
  clearPortalAccountSession: vi.fn(),
  connectPortalAccount: vi.fn(),
  disconnectPortalAccount: vi.fn(),
  loadStoredPortalAccountSession: vi.fn(),
  restorePortalAccountSession: vi.fn(),
  trackProductEvent: vi.fn(),
}))

vi.mock('@/services/portalAccount', () => ({
  ...mocks,
  isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  PORTAL_ACCOUNT_SESSION_CHANGED_EVENT: 'portal-account-session-changed',
}))

vi.mock('@/features/analytics/lib/productAnalytics', () => ({
  trackProductEvent: mocks.trackProductEvent,
  normalizeAnalyticsSubscriptionState: (value: unknown) => value === 'trialing' ? 'trial' : 'unknown',
}))

import { useKitionAccount } from './useKitionAccount'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const session = {
  access_token: 'account-token',
  token_prefix: 'account',
  user_id: 7,
  user_email: 'user@kition.ai',
  expires_at: '2026-08-01T00:00:00Z',
}

let container: HTMLDivElement
let root: Root | null = null

async function renderAccountHook() {
  const ref: { current: ReturnType<typeof useKitionAccount> | null } = { current: null }
  function Harness() {
    ref.current = useKitionAccount()
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
    await Promise.resolve()
    await Promise.resolve()
  })
  return ref
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.restorePortalAccountSession.mockResolvedValue(null)
  mocks.loadStoredPortalAccountSession.mockResolvedValue(null)
  mocks.clearPortalAccountSession.mockResolvedValue(undefined)
  mocks.disconnectPortalAccount.mockResolvedValue(undefined)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

describe('useKitionAccount', () => {
  it('restores a ready account on mount', async () => {
    mocks.restorePortalAccountSession.mockResolvedValue(session)

    const ref = await renderAccountHook()

    expect(ref.current?.state).toEqual({
      status: 'ready',
      session,
      errorMessage: '',
    })
    expect(mocks.trackProductEvent).toHaveBeenCalledWith('account_state_refreshed', {
      result: 'success',
      account_state: 'ready',
      subscription_state: 'unknown',
    })
  })

  it('reports signed out when no account can be restored', async () => {
    const ref = await renderAccountHook()

    expect(ref.current?.state.status).toBe('signed_out')
    expect(ref.current?.state.session).toBeNull()
  })

  it('signs in and becomes ready through ensureReady', async () => {
    const trialSession = { ...session, subscription_status: 'trialing' }
    mocks.connectPortalAccount.mockResolvedValue(trialSession)
    const ref = await renderAccountHook()

    await act(async () => {
      await ref.current?.ensureReady()
    })

    expect(mocks.connectPortalAccount).toHaveBeenCalledTimes(1)
    expect(ref.current?.state).toEqual({
      status: 'ready',
      session: trialSession,
      errorMessage: '',
    })
    expect(mocks.trackProductEvent).toHaveBeenCalledWith('account_sign_in_started')
    expect(mocks.trackProductEvent).toHaveBeenCalledWith('account_sign_in_completed', {
      result: 'success',
      account_state: 'ready',
      subscription_state: 'trial',
    })
  })

  it('returns to signed out when browser sign-in is cancelled', async () => {
    mocks.connectPortalAccount.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    const ref = await renderAccountHook()

    await act(async () => {
      const pending = ref.current?.connect()
      await Promise.resolve()
      ref.current?.cancelConnect()
      await pending
    })

    expect(ref.current?.state.status).toBe('signed_out')
    expect(ref.current?.state.errorMessage).toBe('')
    expect(mocks.trackProductEvent).not.toHaveBeenCalledWith(
      'account_sign_in_failed',
      expect.anything(),
    )
  })

  it('records a coarse sign-in failure without account identity', async () => {
    mocks.connectPortalAccount.mockRejectedValue(new Error('private account error'))
    const ref = await renderAccountHook()

    await act(async () => {
      await ref.current?.ensureReady()
    })

    expect(mocks.trackProductEvent).toHaveBeenCalledWith('account_sign_in_failed', {
      result: 'failure',
      account_state: 'temporary_error',
    })
    expect(JSON.stringify(mocks.trackProductEvent.mock.calls)).not.toContain('private account error')
  })

  it('keeps a temporary restore failure distinct from signed out', async () => {
    mocks.restorePortalAccountSession.mockRejectedValue(new Error('Service unavailable'))
    mocks.loadStoredPortalAccountSession.mockResolvedValue(session)

    const ref = await renderAccountHook()

    expect(ref.current?.state).toEqual({
      status: 'temporary_error',
      session,
      errorMessage: 'Service unavailable',
    })
  })

  it('shows expired credentials as a recoverable sign-in state', async () => {
    mocks.restorePortalAccountSession.mockRejectedValue(Object.assign(
      new Error('Your Kition sign-in has expired. Sign in again to continue.'),
      { code: 'expired' },
    ))

    const ref = await renderAccountHook()

    expect(ref.current?.state).toEqual({
      status: 'expired',
      session: null,
      errorMessage: 'Your Kition sign-in has expired. Sign in again to continue.',
    })
  })

  it('derives low and empty credit states from the restored account', async () => {
    mocks.restorePortalAccountSession.mockResolvedValue({
      ...session,
      credit_total: 100,
      credit_balance: 20,
    })
    const ref = await renderAccountHook()
    expect(ref.current?.state.status).toBe('credits_low')

    mocks.loadStoredPortalAccountSession.mockResolvedValue({
      ...session,
      credit_total: 100,
      credit_balance: 0,
    })
    await act(async () => {
      window.dispatchEvent(new Event('portal-account-session-changed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(ref.current?.state.status).toBe('credits_empty')
  })

  it('synchronizes when another account surface changes the stored session', async () => {
    const ref = await renderAccountHook()
    mocks.loadStoredPortalAccountSession.mockResolvedValue(session)

    await act(async () => {
      window.dispatchEvent(new Event('portal-account-session-changed'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(ref.current?.state.status).toBe('ready')
    expect(ref.current?.state.session).toEqual(session)
  })

  it('ignores a stale stored-session read after a newer refresh completes', async () => {
    const ref = await renderAccountHook()
    let resolveStaleRead: (value: PortalAccountSession) => void = () => {}
    mocks.loadStoredPortalAccountSession.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStaleRead = resolve
    }))

    await act(async () => {
      window.dispatchEvent(new Event('portal-account-session-changed'))
      await Promise.resolve()
    })

    const refreshedSession = {
      ...session,
      credit_total: 100,
      credit_balance: 75,
    }
    mocks.restorePortalAccountSession.mockResolvedValue(refreshedSession)
    await act(async () => {
      await ref.current?.refresh()
    })

    await act(async () => {
      resolveStaleRead({ ...session, credit_total: 100, credit_balance: 20 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(ref.current?.state.session?.credit_balance).toBe(75)
  })
})
