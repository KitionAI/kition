import {
  getPortalConnectResult,
  getPortalSessionStatus,
  logoutPortalSession,
  startPortalConnect,
  type PortalAccountSession,
} from '@/api/desktop'
import { deleteSecureValue, getSecureValue, openExternalURL, setSecureValue } from '@/services/desktop'
import {
  desktopProviderCatalog,
  loadDesktopSettings,
  saveDesktopSettings,
} from '@/services/desktopSettings'
import { syncProviderModelCatalog } from '@/services/providerModelCatalog'
import type { DesktopProviderKind } from '@/types/desktopSettings'

export const PORTAL_ACCOUNT_STORAGE_KEY = 'kition.portal.account.session.v1'
export const PORTAL_ACCOUNT_SESSION_CHANGED_EVENT = 'portal-account-session-changed'
const PORTAL_PREVIOUS_ACTIVE_PROVIDER_KEY = 'kition.desktop.previousActiveProvider.v1'

export type PortalAccountRestoreFailureCode = 'missing' | 'expired' | 'temporary_failure'

export class PortalAccountRestoreFailure extends Error {
  code: PortalAccountRestoreFailureCode

  constructor(code: PortalAccountRestoreFailureCode, message: string) {
    super(message)
    this.name = 'PortalAccountRestoreFailure'
    this.code = code
  }
}

let portalAccountRestorePromise: Promise<PortalAccountSession | null> | null = null

export type { PortalAccountSession } from '@/api/desktop'

function isKnownProviderKind(value: string): value is DesktopProviderKind {
  return desktopProviderCatalog.some((descriptor) => descriptor.kind === value)
}

async function activateKitionConsoleProvider(accessToken: string) {
  try {
    const settings = await loadDesktopSettings()
    let activatedSettings = settings
    if (
      settings.models.activeProvider !== 'kition_console'
      || !settings.providers.kition_console?.enabled
      || settings.providers.kition_console.accessToken !== accessToken
    ) {
      const previousActive = settings.models.activeProvider
      if (previousActive && previousActive !== 'kition_console') {
        await setSecureValue(PORTAL_PREVIOUS_ACTIVE_PROVIDER_KEY, previousActive).catch(() => {})
      }
      activatedSettings = await saveDesktopSettings({
        ...settings,
        providers: {
          ...settings.providers,
          kition_console: {
            ...settings.providers.kition_console,
            enabled: true,
            accessToken,
          },
        },
        models: {
          ...settings.models,
          activeProvider: 'kition_console',
        },
      })
    }

    await syncProviderModelCatalog(
      activatedSettings,
      'kition_console',
      'Kition Cloud did not return an available text model.',
      true,
    )
  } catch {
    // Settings store may be unavailable (e.g. tests). Failing to activate the
    // kition_console provider should never block the portal sign-in flow.
  }
}

async function restorePreviousActiveProvider() {
  try {
    const settings = await loadDesktopSettings()
    if (settings.models.activeProvider !== 'kition_console') {
      // Clear any stale "previous" pointer; the user has already moved on.
      await deleteSecureValue(PORTAL_PREVIOUS_ACTIVE_PROVIDER_KEY).catch(() => {})
      return
    }
    const stored = (await getSecureValue(PORTAL_PREVIOUS_ACTIVE_PROVIDER_KEY).catch(() => '') || '').trim()
    const fallback: DesktopProviderKind = isKnownProviderKind(stored) && stored !== 'kition_console'
      ? stored
      : 'openai'
    await saveDesktopSettings({
      ...settings,
      providers: {
        ...settings.providers,
        kition_console: {
          ...settings.providers.kition_console,
          enabled: false,
          accessToken: '',
        },
      },
      models: {
        ...settings.models,
        activeProvider: fallback,
      },
    }, { clearProviderSecrets: ['kition_console'] })
    await deleteSecureValue(PORTAL_PREVIOUS_ACTIVE_PROVIDER_KEY).catch(() => {})
  } catch {
    // Same rationale as activateKitionConsoleProvider; never block logout.
  }
}

function createAbortError() {
  const error = new Error('portal account flow aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function optionalUnixMilliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function optionalUnixMillisecondsOrNull(value: unknown): number | null | undefined {
  return value === null ? null : optionalUnixMilliseconds(value)
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (value === undefined) {
    return undefined
  }
  const text = String(value).trim()
  return text ? text : undefined
}

function hasCreditSummary(session: PortalAccountSession) {
  return Number.isFinite(session.credit_total) && Number.isFinite(session.credit_balance)
}

function emitPortalAccountSessionChanged() {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new Event(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT))
}

async function wait(ms: number, signal?: AbortSignal) {
  assertNotAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeoutID = window.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    function onAbort() {
      cleanup()
      reject(createAbortError())
    }

    function cleanup() {
      window.clearTimeout(timeoutID)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizePortalAccountSession(value: unknown): PortalAccountSession | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const accessToken = String(record.access_token || '').trim()
  if (!accessToken) {
    return null
  }
  const expiresAt = optionalUnixMilliseconds(record.expires_at)
  if (expiresAt === undefined) {
    return null
  }

  const session: PortalAccountSession = {
    access_token: accessToken,
    token_prefix: String(record.token_prefix || '').trim(),
    user_id: Number(record.user_id || 0),
    user_email: String(record.user_email || '').trim(),
    expires_at: expiresAt,
  }
  const summary = record.credit_summary && typeof record.credit_summary === 'object' ? (record.credit_summary as Record<string, unknown>) : {}
  const creditTotal = optionalNumber(summary.credit_total ?? record.credit_total)
  const creditBalance = optionalNumber(summary.credit_balance ?? record.credit_balance)
  const creditSpent = optionalNumber(summary.credit_spent ?? record.credit_spent)
  const periodCreditTotal = optionalNumber(summary.period_credit_total ?? record.period_credit_total)
  const periodCreditBalance = optionalNumber(summary.period_credit_balance ?? record.period_credit_balance)
  const periodCreditSpent = optionalNumber(summary.period_credit_spent ?? record.period_credit_spent)
  const walletCreditTotal = optionalNumber(summary.wallet_credit_total ?? record.wallet_credit_total)
  const walletCreditBalance = optionalNumber(summary.wallet_credit_balance ?? record.wallet_credit_balance)
  const walletCreditSpent = optionalNumber(summary.wallet_credit_spent ?? record.wallet_credit_spent)
  const planCode = optionalStringOrNull(summary.plan_code ?? record.plan_code)
  const planDisplayName = optionalStringOrNull(summary.plan_display_name ?? record.plan_display_name)
  const planType = optionalStringOrNull(summary.plan_type ?? record.plan_type)
  const subscriptionStatus = optionalStringOrNull(summary.subscription_status ?? record.subscription_status)
  const creditPurchasedTotal = optionalNumber(summary.credit_purchased_total ?? record.credit_purchased_total)
  const creditGrantedTotal = optionalNumber(summary.credit_granted_total ?? record.credit_granted_total)
  const lifetimeCreditTotal = optionalNumber(summary.lifetime_credit_total ?? record.lifetime_credit_total)
  const creditResetCycle = optionalStringOrNull(summary.credit_reset_cycle ?? record.credit_reset_cycle)
  const creditResetAt = optionalUnixMillisecondsOrNull(summary.credit_reset_at ?? record.credit_reset_at)
  const billingUrl = optionalStringOrNull(record.billing_url)
  const topupUrl = optionalStringOrNull(record.topup_url)
  const supportUrl = optionalStringOrNull(record.support_url)
  const termsUrl = optionalStringOrNull(record.terms_url)
  const privacyUrl = optionalStringOrNull(record.privacy_url)
  if (creditTotal !== undefined) {
    session.credit_total = creditTotal
  }
  if (creditBalance !== undefined) {
    session.credit_balance = creditBalance
  }
  if (creditSpent !== undefined) {
    session.credit_spent = creditSpent
  }
  if (periodCreditTotal !== undefined) {
    session.period_credit_total = periodCreditTotal
  }
  if (periodCreditBalance !== undefined) {
    session.period_credit_balance = periodCreditBalance
  }
  if (periodCreditSpent !== undefined) {
    session.period_credit_spent = periodCreditSpent
  }
  if (walletCreditTotal !== undefined) {
    session.wallet_credit_total = walletCreditTotal
  }
  if (walletCreditBalance !== undefined) {
    session.wallet_credit_balance = walletCreditBalance
  }
  if (walletCreditSpent !== undefined) {
    session.wallet_credit_spent = walletCreditSpent
  }
  if (planCode !== undefined && planCode !== null) {
    session.plan_code = planCode
  }
  if (planDisplayName !== undefined && planDisplayName !== null) {
    session.plan_display_name = planDisplayName
  }
  if (planType !== undefined && planType !== null) {
    session.plan_type = planType
  }
  if (subscriptionStatus !== undefined && subscriptionStatus !== null) {
    session.subscription_status = subscriptionStatus
  }
  if (creditPurchasedTotal !== undefined) {
    session.credit_purchased_total = creditPurchasedTotal
  }
  if (creditGrantedTotal !== undefined) {
    session.credit_granted_total = creditGrantedTotal
  }
  if (lifetimeCreditTotal !== undefined) {
    session.lifetime_credit_total = lifetimeCreditTotal
  }
  if (creditResetCycle !== undefined && creditResetCycle !== null) {
    session.credit_reset_cycle = creditResetCycle
  }
  if (creditResetAt !== undefined) {
    session.credit_reset_at = creditResetAt
  }
  if (billingUrl) session.billing_url = billingUrl
  if (topupUrl) session.topup_url = topupUrl
  if (supportUrl) session.support_url = supportUrl
  if (termsUrl) session.terms_url = termsUrl
  if (privacyUrl) session.privacy_url = privacyUrl
  if (hasCreditSummary(session)) {
    session.credit_summary = {
      credit_total: session.credit_total,
      credit_balance: session.credit_balance,
      credit_spent: session.credit_spent,
      period_credit_total: session.period_credit_total,
      period_credit_balance: session.period_credit_balance,
      period_credit_spent: session.period_credit_spent,
      wallet_credit_total: session.wallet_credit_total,
      wallet_credit_balance: session.wallet_credit_balance,
      wallet_credit_spent: session.wallet_credit_spent,
      plan_code: session.plan_code,
      plan_display_name: session.plan_display_name,
      plan_type: session.plan_type,
      subscription_status: session.subscription_status,
      credit_purchased_total: session.credit_purchased_total,
      credit_granted_total: session.credit_granted_total,
      lifetime_credit_total: session.lifetime_credit_total,
      credit_reset_cycle: session.credit_reset_cycle,
      credit_reset_at: session.credit_reset_at,
    }
  }
  return session
}

export async function loadStoredPortalAccountSession() {
  const raw = (await getSecureValue(PORTAL_ACCOUNT_STORAGE_KEY)).trim()
  if (!raw) {
    return null
  }

  try {
    const session = normalizePortalAccountSession(JSON.parse(raw))
    if (!session) {
      await deleteSecureValue(PORTAL_ACCOUNT_STORAGE_KEY)
    }
    return session
  } catch {
    await deleteSecureValue(PORTAL_ACCOUNT_STORAGE_KEY)
    return null
  }
}

export async function savePortalAccountSession(session: PortalAccountSession) {
  await setSecureValue(PORTAL_ACCOUNT_STORAGE_KEY, JSON.stringify(session))
  await activateKitionConsoleProvider(session.access_token)
  emitPortalAccountSessionChanged()
  return session
}

export async function clearPortalAccountSession() {
  await deleteSecureValue(PORTAL_ACCOUNT_STORAGE_KEY)
  await restorePreviousActiveProvider()
  emitPortalAccountSessionChanged()
}

function hydrateStoredPortalSession(
  stored: PortalAccountSession,
  status: Awaited<ReturnType<typeof getPortalSessionStatus>>,
): PortalAccountSession {
  return {
    access_token: stored.access_token,
    token_prefix: status.token_prefix || stored.token_prefix,
    user_id: status.user_id || stored.user_id,
    user_email: status.user_email || stored.user_email,
    expires_at: status.expires_at ?? stored.expires_at,
    credit_total: status.credit_total ?? stored.credit_total,
    credit_balance: status.credit_balance ?? stored.credit_balance,
    credit_spent: status.credit_spent ?? stored.credit_spent,
    period_credit_total: status.period_credit_total ?? stored.period_credit_total,
    period_credit_balance: status.period_credit_balance ?? stored.period_credit_balance,
    period_credit_spent: status.period_credit_spent ?? stored.period_credit_spent,
    wallet_credit_total: status.wallet_credit_total ?? stored.wallet_credit_total,
    wallet_credit_balance: status.wallet_credit_balance ?? stored.wallet_credit_balance,
    wallet_credit_spent: status.wallet_credit_spent ?? stored.wallet_credit_spent,
    plan_code: status.plan_code || stored.plan_code,
    plan_display_name: status.plan_display_name || stored.plan_display_name,
    plan_type: status.plan_type || stored.plan_type,
    subscription_status: status.subscription_status || stored.subscription_status,
    credit_purchased_total: status.credit_purchased_total ?? stored.credit_purchased_total,
    credit_granted_total: status.credit_granted_total ?? stored.credit_granted_total,
    lifetime_credit_total: status.lifetime_credit_total ?? stored.lifetime_credit_total,
    credit_reset_cycle: status.credit_reset_cycle || stored.credit_reset_cycle,
    credit_reset_at: status.credit_reset_at ?? stored.credit_reset_at,
    billing_url: status.billing_url || stored.billing_url,
    topup_url: status.topup_url || stored.topup_url,
    support_url: status.support_url || stored.support_url,
    terms_url: status.terms_url || stored.terms_url,
    privacy_url: status.privacy_url || stored.privacy_url,
    // Do not carry a stored summary across a live refresh. It may contain an
    // older balance than the merged top-level fields and would win during the
    // next normalization pass. A fresh summary is rebuilt from those fields.
    credit_summary: status.credit_summary,
  }
}

async function restorePortalAccountSessionOnce() {
  const stored = await loadStoredPortalAccountSession()
  if (!stored) {
    return null
  }

  try {
    const status = await getPortalSessionStatus(stored.access_token)
    if (!status.authenticated) {
      await clearPortalAccountSession()
      throw new PortalAccountRestoreFailure(
        'expired',
        'Your Kition sign-in has expired. Sign in again to continue.',
      )
    }

    const hydrated = hydrateStoredPortalSession(stored, status)
    await savePortalAccountSession(hydrated)
    return hydrated
  } catch (error) {
    if (error instanceof PortalAccountRestoreFailure) {
      throw error
    }
    throw new PortalAccountRestoreFailure(
      'temporary_failure',
      error instanceof Error && error.message
        ? error.message
        : 'Kition Account could not be restored. Please try again.',
    )
  }
}

export async function restorePortalAccountSession() {
  if (!portalAccountRestorePromise) {
    portalAccountRestorePromise = restorePortalAccountSessionOnce().finally(() => {
      portalAccountRestorePromise = null
    })
  }
  return portalAccountRestorePromise
}

export async function ensurePortalAccountSessionRestored() {
  const session = await restorePortalAccountSession()
  if (!session) {
    throw new PortalAccountRestoreFailure(
      'missing',
      'Sign in to Kition before using Kition Cloud models.',
    )
  }
  return session
}

export async function connectPortalAccount(options: { signal?: AbortSignal } = {}) {
  const start = await startPortalConnect()
  assertNotAborted(options.signal)

  await openExternalURL(start.authorize_url)

  while (true) {
    assertNotAborted(options.signal)
    const result = await getPortalConnectResult(start.session_id)

    if (result.status === 'completed' && result.session) {
      await savePortalAccountSession(result.session)
      return result.session
    }

    if (result.status === 'error') {
      throw new Error(result.error_message || 'Kition sign-in failed. Please try again.')
    }

    if (result.status === 'expired') {
      throw new Error(result.error_message || 'Kition sign-in has expired. Please start again.')
    }

    if (result.status !== 'pending') {
      throw new Error('Kition sign-in state is invalid. Please try again.')
    }

    await wait(Math.max(500, start.poll_interval_ms || 0), options.signal)
  }
}

export async function disconnectPortalAccount(session?: PortalAccountSession | null) {
  const target = session || (await loadStoredPortalAccountSession())
  try {
    if (target?.access_token) {
      await logoutPortalSession(target.access_token)
    }
  } finally {
    await clearPortalAccountSession()
  }
}

export { isAbortError }
