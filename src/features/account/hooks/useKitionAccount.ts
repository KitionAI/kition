import { useSyncExternalStore } from 'react'

import type { PortalAccountSession } from '@/api/desktop'
import {
  classifyKitionAccountSession,
  type KitionAccountStatus,
} from '@/features/account/lib/accountState'
import {
  clearPortalAccountSession,
  connectPortalAccount,
  disconnectPortalAccount,
  isAbortError,
  loadStoredPortalAccountSession,
  PORTAL_ACCOUNT_SESSION_CHANGED_EVENT,
  restorePortalAccountSession,
} from '@/services/portalAccount'
import {
  normalizeAnalyticsSubscriptionState,
  trackProductEvent,
} from '@/features/analytics/lib/productAnalytics'

export type { KitionAccountStatus } from '@/features/account/lib/accountState'

export type KitionAccountState = {
  status: KitionAccountStatus
  session: PortalAccountSession | null
  errorMessage: string
}

const initialState: KitionAccountState = {
  status: 'loading',
  session: null,
  errorMessage: '',
}

let accountState = initialState
let initialized = false
let subscriberCount = 0
let stateRequestVersion = 0
let connectAbortController: AbortController | null = null
let connectPromise: Promise<PortalAccountSession | null> | null = null
const listeners = new Set<() => void>()

function readyState(session: PortalAccountSession): KitionAccountState {
  return {
    status: classifyKitionAccountSession(session),
    session,
    errorMessage: '',
  }
}

function trackAccountStateRefresh(state: KitionAccountState, result: 'success' | 'failure') {
  trackProductEvent('account_state_refreshed', {
    result,
    account_state: state.status,
    subscription_state: normalizeAnalyticsSubscriptionState(state.session?.subscription_status),
  })
}

function isExpiredRestoreError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'expired',
  )
}

function publish(next: KitionAccountState) {
  accountState = next
  listeners.forEach((listener) => listener())
}

function publishIfCurrent(version: number, next: KitionAccountState) {
  if (version === stateRequestVersion) {
    publish(next)
    return true
  }
  return false
}

function getSnapshot() {
  return accountState
}

async function syncStoredSession() {
  const version = ++stateRequestVersion
  try {
    const session = await loadStoredPortalAccountSession()
    publishIfCurrent(version, session
      ? readyState(session)
      : { status: 'signed_out', session: null, errorMessage: '' })
    return session
  } catch (error) {
    publishIfCurrent(version, {
      status: 'temporary_error',
      session: accountState.session,
      errorMessage: error instanceof Error
        ? error.message
        : 'Kition Account could not be synchronized. Please try again.',
    })
    return null
  }
}

async function restore() {
  const version = ++stateRequestVersion
  publish({ status: 'loading', session: null, errorMessage: '' })
  try {
    const session = await restorePortalAccountSession()
    const next = session
      ? readyState(session)
      : { status: 'signed_out' as const, session: null, errorMessage: '' }
    if (publishIfCurrent(version, next)) {
      trackAccountStateRefresh(next, 'success')
    }
    return session
  } catch (error) {
    const storedSession = await loadStoredPortalAccountSession().catch(() => null)
    const failureVersion = ++stateRequestVersion
    const next: KitionAccountState = isExpiredRestoreError(error)
      ? {
          status: 'expired',
          session: null,
          errorMessage: error instanceof Error ? error.message : 'Your Kition sign-in has expired.',
        }
      : {
          status: 'temporary_error',
          session: storedSession,
          errorMessage: error instanceof Error
            ? error.message
            : 'Kition Account could not be restored. Please try again.',
        }
    if (publishIfCurrent(failureVersion, next)) {
      trackAccountStateRefresh(next, 'failure')
    }
    return null
  }
}

async function connect() {
  if (connectPromise) return connectPromise

  connectAbortController?.abort()
  const controller = new AbortController()
  const version = ++stateRequestVersion
  connectAbortController = controller
  trackProductEvent('account_sign_in_started')
  publish({ status: 'connecting', session: null, errorMessage: '' })

  const pending = connectPortalAccount({ signal: controller.signal })
    .then((session) => {
      const accountStatus = classifyKitionAccountSession(session)
      if (publishIfCurrent(version, readyState(session))) {
        trackProductEvent('account_sign_in_completed', {
          result: 'success',
          account_state: accountStatus,
          subscription_state: normalizeAnalyticsSubscriptionState(session.subscription_status),
        })
      }
      return session
    })
    .catch(async (error) => {
      if (isAbortError(error)) {
        publishIfCurrent(version, { status: 'signed_out', session: null, errorMessage: '' })
        return null
      }
      await clearPortalAccountSession().catch(() => {})
      trackProductEvent('account_sign_in_failed', {
        result: 'failure',
        account_state: 'temporary_error',
      })
      const failureVersion = ++stateRequestVersion
      publishIfCurrent(failureVersion, {
        status: 'temporary_error',
        session: null,
        errorMessage: error instanceof Error
          ? error.message
          : 'Kition Account sign-in failed. Please try again.',
      })
      return null
    })
    .finally(() => {
      if (connectAbortController === controller) {
        connectAbortController = null
      }
      connectPromise = null
    })

  connectPromise = pending
  return pending
}

async function ensureReady() {
  const version = ++stateRequestVersion
  try {
    const session = await restorePortalAccountSession()
    if (session) {
      const next = readyState(session)
      if (publishIfCurrent(version, next)) {
        trackAccountStateRefresh(next, 'success')
      }
      return session
    }
  } catch (error) {
    const storedSession = await loadStoredPortalAccountSession().catch(() => null)
    const failureVersion = ++stateRequestVersion
    if (isExpiredRestoreError(error)) {
      const next: KitionAccountState = {
        status: 'expired',
        session: null,
        errorMessage: error instanceof Error ? error.message : 'Your Kition sign-in has expired.',
      }
      if (publishIfCurrent(failureVersion, next)) {
        trackAccountStateRefresh(next, 'failure')
      }
      return null
    }
    const next: KitionAccountState = {
      status: 'temporary_error',
      session: storedSession,
      errorMessage: error instanceof Error
        ? error.message
        : 'Kition Account could not be restored. Please try again.',
    }
    if (publishIfCurrent(failureVersion, next)) {
      trackAccountStateRefresh(next, 'failure')
    }
    return null
  }
  return connect()
}

function cancelConnect() {
  connectAbortController?.abort()
}

async function logout() {
  const session = accountState.session
  publish({ status: 'loading', session: null, errorMessage: '' })
  try {
    await disconnectPortalAccount(session)
  } finally {
    const version = ++stateRequestVersion
    publishIfCurrent(version, { status: 'signed_out', session: null, errorMessage: '' })
  }
}

function handleSessionChanged() {
  void syncStoredSession()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  subscriberCount += 1
  if (subscriberCount === 1) {
    window.addEventListener(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT, handleSessionChanged)
  }
  if (!initialized) {
    initialized = true
    void restore()
  }

  return () => {
    listeners.delete(listener)
    subscriberCount = Math.max(0, subscriberCount - 1)
    if (subscriberCount === 0) {
      window.removeEventListener(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT, handleSessionChanged)
      connectAbortController?.abort()
      connectAbortController = null
      connectPromise = null
      initialized = false
      stateRequestVersion += 1
      accountState = initialState
    }
  }
}

export function useKitionAccount() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    state,
    connect,
    ensureReady,
    cancelConnect,
    logout,
    refresh: restore,
  }
}
