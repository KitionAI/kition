import { beforeEach, describe, expect, it, vi } from 'vitest'

const secureValues = new Map<string, string>()

const startPortalConnect = vi.fn()
const getPortalConnectResult = vi.fn()
const getPortalSessionStatus = vi.fn()
const logoutPortalSession = vi.fn()
const syncProviderModelCatalog = vi.fn()
const openExternalURL = vi.fn()

vi.mock('@/api/desktop', () => ({
  startPortalConnect,
  getPortalConnectResult,
  getPortalSessionStatus,
  logoutPortalSession,
}))

vi.mock('@/services/providerModelCatalog', () => ({
  syncProviderModelCatalog,
}))

vi.mock('@/services/desktop', () => ({
  openExternalURL,
  getSecureValue: vi.fn(async (key: string) => secureValues.get(key) || ''),
  setSecureValue: vi.fn(async (key: string, value: string) => {
    secureValues.set(key, value)
  }),
  deleteSecureValue: vi.fn(async (key: string) => {
    secureValues.delete(key)
  }),
}))

async function waitForMockCall(mock: { mock: { calls: unknown[] } }) {
  for (let index = 0; index < 20; index += 1) {
    if (mock.mock.calls.length > 0) {
      return
    }
    await Promise.resolve()
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
}

describe('portal account service', () => {
  beforeEach(() => {
    vi.resetModules()
    secureValues.clear()
    localStorage.clear()
    startPortalConnect.mockReset()
    getPortalConnectResult.mockReset()
    getPortalSessionStatus.mockReset()
    logoutPortalSession.mockReset()
    syncProviderModelCatalog.mockReset()
    syncProviderModelCatalog.mockImplementation(async (settings) => settings)
    openExternalURL.mockReset()
    vi.useRealTimers()
  })

  it('restores a persisted session when portal still authenticates the token', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-toke',
        user_id: 7,
        user_email: 'old@example.com',
        expires_at: '2026-06-05T00:00:00Z',
      }),
    )
    secureValues.set(
      'kition.desktop.settings.v1',
      JSON.stringify({
        providers: {
          openai: { enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', discoveredModels: ['gpt-4.1'] },
          kition_console: { enabled: false, label: 'Kition Console', discoveredModels: ['gpt-5.5'] },
        },
        models: {
          activeProvider: 'openai',
          selectedModelByProvider: { openai: 'gpt-4.1' },
        },
      }),
    )
    getPortalSessionStatus.mockResolvedValue({
      authenticated: true,
      user_id: 7,
      user_email: 'portal@example.com',
      token_prefix: 'portal-token',
      expires_at: '2026-06-06T00:00:00Z',
      credit_total: 150,
      credit_balance: 87,
      credit_spent: 63,
      period_credit_total: 100,
      period_credit_balance: 60,
      period_credit_spent: 40,
      wallet_credit_total: 50,
      wallet_credit_balance: 27,
      wallet_credit_spent: 23,
      plan_code: 'basic',
      plan_display_name: 'Kition Basic',
      plan_type: 'subscription',
      subscription_status: 'active',
      credit_purchased_total: 50,
      credit_granted_total: 100,
      lifetime_credit_total: 150,
      credit_reset_cycle: 'none',
      credit_reset_at: null,
      billing_url: 'https://billing.kition.ai/manage',
      topup_url: 'https://billing.kition.ai/topup',
      support_url: 'mailto:support@kition.ai',
      terms_url: 'https://kition.ai/terms',
      privacy_url: 'https://kition.ai/privacy',
    })

    const { restorePortalAccountSession } = await import('./portalAccount')
    const session = await restorePortalAccountSession()

    expect(session).toMatchObject({
      access_token: 'portal-token',
      user_email: 'portal@example.com',
      expires_at: '2026-06-06T00:00:00Z',
      credit_total: 150,
      credit_balance: 87,
      credit_spent: 63,
      period_credit_total: 100,
      period_credit_balance: 60,
      wallet_credit_total: 50,
      wallet_credit_balance: 27,
      plan_code: 'basic',
      plan_display_name: 'Kition Basic',
      plan_type: 'subscription',
      subscription_status: 'active',
      credit_purchased_total: 50,
      credit_granted_total: 100,
      lifetime_credit_total: 150,
      billing_url: 'https://billing.kition.ai/manage',
      topup_url: 'https://billing.kition.ai/topup',
      support_url: 'mailto:support@kition.ai',
      terms_url: 'https://kition.ai/terms',
      privacy_url: 'https://kition.ai/privacy',
    })
    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"user_email":"portal@example.com"')
    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"credit_total":150')
    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"credit_balance":87')
    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"period_credit_total":100')
    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"wallet_credit_balance":27')
    const settings = JSON.parse(secureValues.get('kition.desktop.settings.v1') || '{}')
    expect(settings.providers.kition_console.enabled).toBe(true)
    expect(secureValues.get('desktop.provider.kition_console.accessToken.v1')).toBe('portal-token')
    expect(settings.models.activeProvider).toBe('kition_console')
    expect(syncProviderModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({ activeProvider: 'kition_console' }),
      }),
      'kition_console',
      'Kition Cloud did not return an available text model.',
      true,
    )
  })

  it('clears the persisted session when portal rejects the token', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-toke',
        user_id: 7,
        user_email: 'portal@example.com',
        expires_at: '2026-06-05T00:00:00Z',
      }),
    )
    secureValues.set('kition.desktop.previousActiveProvider.v1', 'openai')
    secureValues.set(
      'kition.desktop.settings.v1',
      JSON.stringify({
        providers: {
          openai: { enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', discoveredModels: ['gpt-4.1'] },
          kition_console: { enabled: true, label: 'Kition Console', discoveredModels: ['gpt-5.5'] },
        },
        models: {
          activeProvider: 'kition_console',
          selectedModelByProvider: { kition_console: 'gpt-5.5', openai: 'gpt-4.1' },
        },
      }),
    )
    getPortalSessionStatus.mockResolvedValue({
      authenticated: false,
    })

    const { restorePortalAccountSession } = await import('./portalAccount')
    await expect(restorePortalAccountSession()).rejects.toMatchObject({
      code: 'expired',
      message: 'Your Kition sign-in has expired. Sign in again to continue.',
    })

    expect(secureValues.get('kition.portal.account.session.v1') || '').toBe('')
    const settings = JSON.parse(secureValues.get('kition.desktop.settings.v1') || '{}')
    expect(settings.providers.kition_console.enabled).toBe(false)
    expect(settings.models.activeProvider).toBe('openai')
  })

  it('keeps the persisted session when portal status temporarily fails', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-toke',
        user_id: 7,
        user_email: 'portal@example.com',
        expires_at: '2026-06-05T00:00:00Z',
      }),
    )
    getPortalSessionStatus.mockRejectedValue(new Error('portal unavailable'))

    const { restorePortalAccountSession } = await import('./portalAccount')
    await expect(restorePortalAccountSession()).rejects.toMatchObject({
      code: 'temporary_failure',
      message: 'portal unavailable',
    })

    expect(secureValues.get('kition.portal.account.session.v1') || '').toContain('"access_token":"portal-token"')
  })

  it('does not let a stale stored credit summary override a refreshed balance', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-token',
        user_id: 7,
        user_email: 'portal@example.com',
        expires_at: '2026-06-05T00:00:00Z',
        credit_total: 100,
        credit_balance: 20,
        credit_summary: {
          credit_total: 100,
          credit_balance: 20,
        },
      }),
    )
    getPortalSessionStatus.mockResolvedValue({
      authenticated: true,
      user_id: 7,
      user_email: 'portal@example.com',
      token_prefix: 'portal-token',
      expires_at: '2026-06-06T00:00:00Z',
      credit_total: 100,
      credit_balance: 75,
    })

    const { loadStoredPortalAccountSession, restorePortalAccountSession } = await import('./portalAccount')
    await expect(restorePortalAccountSession()).resolves.toMatchObject({ credit_balance: 75 })
    await expect(loadStoredPortalAccountSession()).resolves.toMatchObject({
      credit_balance: 75,
      credit_summary: { credit_balance: 75 },
    })
  })

  it('dedupes concurrent portal restore requests', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-toke',
        user_id: 7,
        user_email: 'portal@example.com',
        expires_at: '2026-06-05T00:00:00Z',
      }),
    )
    let resolveStatus: (value: any) => void = () => {}
    getPortalSessionStatus.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve
    }))

    const { restorePortalAccountSession } = await import('./portalAccount')
    const first = restorePortalAccountSession()
    const second = restorePortalAccountSession()

    await waitForMockCall(getPortalSessionStatus)
    expect(getPortalSessionStatus).toHaveBeenCalledTimes(1)
    resolveStatus({
      authenticated: true,
      user_id: 7,
      user_email: 'portal@example.com',
      token_prefix: 'portal-token',
      expires_at: '2026-06-06T00:00:00Z',
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ access_token: 'portal-token' }),
      expect.objectContaining({ access_token: 'portal-token' }),
    ])
  })

  it('opens the browser and stores the completed portal session', async () => {
    vi.useFakeTimers()
    startPortalConnect.mockResolvedValue({
      session_id: 'portal-session',
      authorize_url: 'https://portal.example.com/oauth/start',
      expires_at: '2026-06-05T00:00:00Z',
      poll_interval_ms: 1,
    })
    getPortalConnectResult
      .mockResolvedValueOnce({
        status: 'pending',
        expires_at: '2026-06-05T00:00:00Z',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        expires_at: '2026-06-05T00:00:00Z',
        session: {
          access_token: 'portal-token',
          token_prefix: 'portal-token',
          user_id: 7,
          user_email: 'portal@example.com',
          expires_at: '2026-06-06T00:00:00Z',
          credit_total: 150,
          credit_balance: 87,
          credit_spent: 63,
          period_credit_total: 100,
          period_credit_balance: 60,
          period_credit_spent: 40,
          wallet_credit_total: 50,
          wallet_credit_balance: 27,
          wallet_credit_spent: 23,
          plan_code: 'basic',
          plan_type: 'subscription',
          subscription_status: 'active',
          credit_purchased_total: 50,
          credit_granted_total: 100,
          lifetime_credit_total: 150,
          credit_reset_cycle: 'none',
          credit_reset_at: null,
        },
      })

    const { connectPortalAccount, loadStoredPortalAccountSession } = await import('./portalAccount')
    const promise = connectPortalAccount()

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    const session = await promise

    expect(openExternalURL).toHaveBeenCalledWith('https://portal.example.com/oauth/start')
    expect(session.user_email).toBe('portal@example.com')
    await expect(loadStoredPortalAccountSession()).resolves.toMatchObject({
      access_token: 'portal-token',
      user_email: 'portal@example.com',
      credit_total: 150,
      credit_balance: 87,
      credit_spent: 63,
      period_credit_total: 100,
      period_credit_balance: 60,
      wallet_credit_total: 50,
      wallet_credit_balance: 27,
      plan_code: 'basic',
      plan_type: 'subscription',
      subscription_status: 'active',
      credit_purchased_total: 50,
      credit_granted_total: 100,
      lifetime_credit_total: 150,
    })
    expect(syncProviderModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({ activeProvider: 'kition_console' }),
      }),
      'kition_console',
      'Kition Cloud did not return an available text model.',
      true,
    )
    expect(secureValues.get('desktop.provider.kition_console.accessToken.v1')).toBe('portal-token')
  })

  it('clears local persistence after logout even when portal logout succeeds', async () => {
    secureValues.set(
      'kition.portal.account.session.v1',
      JSON.stringify({
        access_token: 'portal-token',
        token_prefix: 'portal-token',
        user_id: 7,
        user_email: 'portal@example.com',
        expires_at: '2026-06-06T00:00:00Z',
      }),
    )
    logoutPortalSession.mockResolvedValue({ success: true })

    const { disconnectPortalAccount } = await import('./portalAccount')
    await disconnectPortalAccount()

    expect(logoutPortalSession).toHaveBeenCalledWith('portal-token')
    expect(secureValues.get('kition.portal.account.session.v1') || '').toBe('')
    expect(secureValues.get('desktop.provider.kition_console.accessToken.v1') || '').toBe('')
  })
})
