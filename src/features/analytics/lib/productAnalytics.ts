import type { KitionAccountStatus } from '@/features/account/lib/accountState'
import type { OnboardingProviderChoice } from '@/features/onboarding/onboardingState'
import type { UpdatePhase } from '@/services/desktopUpdates'

export const PRODUCT_ANALYTICS_EVENT_NAMES = [
  'app_started',
  'workspace_opened',
  'onboarding_started',
  'onboarding_completed',
  'provider_choice_selected',
  'account_sign_in_started',
  'account_sign_in_completed',
  'account_sign_in_failed',
  'account_state_refreshed',
  'agent_first_request_started',
  'agent_first_request_completed',
  'workflow_first_run_completed',
  'credits_low_seen',
  'credits_exhausted_seen',
  'billing_opened',
  'update_check_completed',
  'update_install_completed',
  'support_opened',
] as const

export type ProductAnalyticsEventName = typeof PRODUCT_ANALYTICS_EVENT_NAMES[number]
export type ProductAnalyticsResult = 'success' | 'failure' | 'canceled' | 'offline' | 'unavailable'
export type ProductAnalyticsPlatform = 'macos' | 'windows' | 'linux' | 'web' | 'unknown'
export type ProductAnalyticsBuildIdentity = 'dev' | 'rc' | 'stable'
export type ProductAnalyticsSubscriptionState = 'unknown' | 'trial' | 'active' | 'payment_required' | 'canceled' | 'inactive'

export type ProductAnalyticsFields = {
  result?: ProductAnalyticsResult
  provider_choice?: OnboardingProviderChoice
  account_state?: KitionAccountStatus
  subscription_state?: ProductAnalyticsSubscriptionState
  update_state?: UpdatePhase
}

export type ProductAnalyticsEvent = ProductAnalyticsFields & {
  schema: 'kition-product-event/v1'
  id: string
  name: ProductAnalyticsEventName
  occurred_at: string
  app_version: string
  build_identity: ProductAnalyticsBuildIdentity
  platform: ProductAnalyticsPlatform
  installation_id: string
}

type ProductAnalyticsConfig = {
  enabled: boolean
  appVersion: string
  buildIdentity: ProductAnalyticsBuildIdentity
  platform: ProductAnalyticsPlatform
  endpoint: string
}

const QUEUE_STORAGE_KEY = 'kition.analytics.queue.v1'
const INSTALLATION_STORAGE_KEY = 'kition.analytics.installation.v1'
const ONCE_STORAGE_KEY = 'kition.analytics.once.v1'
const MAX_QUEUE_SIZE = 200
const FLUSH_DELAY_MS = 500

const EVENT_NAME_SET = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES)
const RESULT_SET = new Set<string>(['success', 'failure', 'canceled', 'offline', 'unavailable'])
const PROVIDER_CHOICE_SET = new Set<string>(['cloud', 'byo', 'local'])
const ACCOUNT_STATE_SET = new Set<string>([
  'loading', 'signed_out', 'connecting', 'ready', 'expired', 'credits_low', 'credits_empty', 'temporary_error',
])
const SUBSCRIPTION_STATE_SET = new Set<string>(['unknown', 'trial', 'active', 'payment_required', 'canceled', 'inactive'])
const UPDATE_STATE_SET = new Set<string>([
  'idle', 'unsupported', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error',
])
const PLATFORM_SET = new Set<string>(['macos', 'windows', 'linux', 'web', 'unknown'])
const BUILD_IDENTITY_SET = new Set<string>(['dev', 'rc', 'stable'])
const EVENT_KEYS = new Set([
  'schema', 'id', 'name', 'occurred_at', 'app_version', 'build_identity', 'platform', 'installation_id',
  'result', 'provider_choice', 'account_state', 'update_state',
  'subscription_state',
])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SENSITIVE_VALUE_PATTERN = /(?:https?:\/\/|file:\/\/|\b[A-Za-z]:\\|\/(?:Users|home|tmp|var)\/|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer\s+|\bprompt\b|document contents?|browser history)/i

let config: ProductAnalyticsConfig = {
  enabled: false,
  appVersion: 'unknown',
  buildIdentity: 'dev',
  platform: 'web',
  endpoint: '',
}
let queueSnapshot: ProductAnalyticsEvent[] | null = null
let flushTimer: number | null = null
let activeRequest: AbortController | null = null
let onlineListenerAttached = false
const listeners = new Set<() => void>()

function storageAvailable() {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readJSON(key: string): unknown {
  if (!storageAvailable()) return null
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function writeJSON(key: string, value: unknown) {
  if (!storageAvailable()) return false
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function removeStorage(key: string) {
  if (!storageAvailable()) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Analytics storage never blocks product workflows.
  }
}

function makeId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
  return `${prefix}_${uuid}`.slice(0, 80)
}

function readInstallationId() {
  if (!storageAvailable()) return ''
  const existing = String(window.localStorage.getItem(INSTALLATION_STORAGE_KEY) || '')
  if (IDENTIFIER_PATTERN.test(existing)) return existing
  const created = makeId('anon')
  try {
    window.localStorage.setItem(INSTALLATION_STORAGE_KEY, created)
  } catch {
    return ''
  }
  return created
}

function safeEndpoint(value: string) {
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.toString() : ''
  } catch {
    return ''
  }
}

function notifyQueueChanged() {
  listeners.forEach((listener) => listener())
}

function loadQueue() {
  if (queueSnapshot) return queueSnapshot
  const raw = readJSON(QUEUE_STORAGE_KEY)
  queueSnapshot = Array.isArray(raw)
    ? raw.flatMap((item) => {
        const validation = validateProductAnalyticsEvent(item)
        return validation.ok ? [validation.event] : []
      }).slice(-MAX_QUEUE_SIZE)
    : []
  return queueSnapshot
}

function saveQueue(next: ProductAnalyticsEvent[]) {
  queueSnapshot = next.slice(-MAX_QUEUE_SIZE)
  writeJSON(QUEUE_STORAGE_KEY, queueSnapshot)
  notifyQueueChanged()
}

function readOnceMarkers() {
  const raw = readJSON(ONCE_STORAGE_KEY)
  return Array.isArray(raw)
    ? new Set(raw.filter((item): item is string => typeof item === 'string' && EVENT_NAME_SET.has(item)))
    : new Set<string>()
}

function scheduleFlush() {
  if (!config.enabled || !config.endpoint || flushTimer !== null || typeof window === 'undefined') return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flushProductAnalytics()
  }, FLUSH_DELAY_MS)
}

function attachOnlineListener() {
  if (onlineListenerAttached || typeof window === 'undefined') return
  onlineListenerAttached = true
  window.addEventListener('online', scheduleFlush)
}

export function normalizeAnalyticsPlatform(value: unknown): ProductAnalyticsPlatform {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'darwin' || normalized.includes('mac')) return 'macos'
  if (normalized === 'win32' || normalized.includes('windows')) return 'windows'
  if (normalized === 'linux') return 'linux'
  if (normalized === 'web') return 'web'
  return 'unknown'
}

export function normalizeAnalyticsSubscriptionState(value: unknown): ProductAnalyticsSubscriptionState {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'trial' || normalized === 'trialing') return 'trial'
  if (normalized === 'active' || normalized === 'paid') return 'active'
  if (normalized === 'past_due' || normalized === 'unpaid' || normalized === 'payment_required') return 'payment_required'
  if (normalized === 'canceled' || normalized === 'cancelled') return 'canceled'
  if (normalized === 'inactive' || normalized === 'expired') return 'inactive'
  return 'unknown'
}

export function validateProductAnalyticsEvent(value: unknown):
  | { ok: true; event: ProductAnalyticsEvent }
  | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'event must be an object' }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !EVENT_KEYS.has(key))) return { ok: false, error: 'event contains an unsupported field' }
  if (record.schema !== 'kition-product-event/v1') return { ok: false, error: 'invalid schema' }
  if (!IDENTIFIER_PATTERN.test(String(record.id || ''))) return { ok: false, error: 'invalid event id' }
  if (!EVENT_NAME_SET.has(String(record.name || ''))) return { ok: false, error: 'invalid event name' }
  if (!VERSION_PATTERN.test(String(record.app_version || ''))) return { ok: false, error: 'invalid app version' }
  if (!BUILD_IDENTITY_SET.has(String(record.build_identity || ''))) return { ok: false, error: 'invalid build identity' }
  if (!PLATFORM_SET.has(String(record.platform || ''))) return { ok: false, error: 'invalid platform' }
  if (!IDENTIFIER_PATTERN.test(String(record.installation_id || ''))) return { ok: false, error: 'invalid installation id' }
  const occurredAt = String(record.occurred_at || '')
  if (!TIMESTAMP_PATTERN.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    return { ok: false, error: 'invalid timestamp' }
  }
  if (record.result !== undefined && !RESULT_SET.has(String(record.result))) return { ok: false, error: 'invalid result' }
  if (record.provider_choice !== undefined && !PROVIDER_CHOICE_SET.has(String(record.provider_choice))) return { ok: false, error: 'invalid provider choice' }
  if (record.account_state !== undefined && !ACCOUNT_STATE_SET.has(String(record.account_state))) return { ok: false, error: 'invalid account state' }
  if (record.subscription_state !== undefined && !SUBSCRIPTION_STATE_SET.has(String(record.subscription_state))) return { ok: false, error: 'invalid subscription state' }
  if (record.update_state !== undefined && !UPDATE_STATE_SET.has(String(record.update_state))) return { ok: false, error: 'invalid update state' }
  if (Object.values(record).some((item) => typeof item === 'string' && SENSITIVE_VALUE_PATTERN.test(item))) {
    return { ok: false, error: 'event contains sensitive data' }
  }
  return { ok: true, event: record as ProductAnalyticsEvent }
}

export function configureProductAnalytics(next: {
  enabled: boolean
  appVersion: string
  buildIdentity: string
  platform: unknown
  endpoint?: string
}) {
  const buildIdentity = BUILD_IDENTITY_SET.has(next.buildIdentity) ? next.buildIdentity as ProductAnalyticsBuildIdentity : 'dev'
  config = {
    enabled: next.enabled,
    appVersion: VERSION_PATTERN.test(next.appVersion) ? next.appVersion : 'unknown',
    buildIdentity,
    platform: normalizeAnalyticsPlatform(next.platform),
    endpoint: safeEndpoint(next.endpoint || ''),
  }
  attachOnlineListener()
  if (!config.enabled) {
    if (flushTimer !== null && typeof window !== 'undefined') window.clearTimeout(flushTimer)
    flushTimer = null
    activeRequest?.abort()
    activeRequest = null
    clearProductAnalyticsData()
    return
  }
  scheduleFlush()
}

export function trackProductEvent(name: ProductAnalyticsEventName, fields: ProductAnalyticsFields = {}) {
  if (!config.enabled || !EVENT_NAME_SET.has(name)) return false
  const installationId = readInstallationId()
  if (!installationId) return false
  const candidate: ProductAnalyticsEvent = {
    ...fields,
    schema: 'kition-product-event/v1',
    id: makeId('evt'),
    name,
    occurred_at: new Date().toISOString(),
    app_version: config.appVersion,
    build_identity: config.buildIdentity,
    platform: config.platform,
    installation_id: installationId,
  }
  const validation = validateProductAnalyticsEvent(candidate)
  if (!validation.ok) return false
  saveQueue([...loadQueue(), validation.event])
  scheduleFlush()
  return true
}

export function trackProductEventOnce(name: ProductAnalyticsEventName, fields: ProductAnalyticsFields = {}) {
  if (!config.enabled) return false
  const markers = readOnceMarkers()
  if (markers.has(name)) return false
  const tracked = trackProductEvent(name, fields)
  if (tracked) {
    markers.add(name)
    writeJSON(ONCE_STORAGE_KEY, Array.from(markers))
  }
  return tracked
}

export async function flushProductAnalytics() {
  if (!config.enabled || !config.endpoint || activeRequest) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const events = [...loadQueue()]
  if (!events.length) return true
  const controller = new AbortController()
  activeRequest = controller
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'kition-analytics-batch/v1', events }),
      signal: controller.signal,
      keepalive: true,
    })
    if (!response.ok) return false
    const sentIds = new Set(events.map((event) => event.id))
    saveQueue(loadQueue().filter((event) => !sentIds.has(event.id)))
    return true
  } catch {
    return false
  } finally {
    if (activeRequest === controller) activeRequest = null
  }
}

export function getProductAnalyticsQueue() {
  return loadQueue()
}

export function subscribeProductAnalyticsQueue(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearProductAnalyticsQueue() {
  saveQueue([])
}

export function clearProductAnalyticsData() {
  queueSnapshot = []
  removeStorage(QUEUE_STORAGE_KEY)
  removeStorage(ONCE_STORAGE_KEY)
  removeStorage(INSTALLATION_STORAGE_KEY)
  notifyQueueChanged()
}
