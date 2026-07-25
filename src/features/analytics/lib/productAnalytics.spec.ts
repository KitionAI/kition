import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearProductAnalyticsData,
  configureProductAnalytics,
  flushProductAnalytics,
  getProductAnalyticsQueue,
  PRODUCT_ANALYTICS_EVENT_NAMES,
  trackProductEvent,
  trackProductEventOnce,
  normalizeAnalyticsSubscriptionState,
  validateProductAnalyticsEvent,
} from './productAnalytics'

function enable(endpoint = '') {
  configureProductAnalytics({
    enabled: true,
    appVersion: '1.0.0-beta.3',
    buildIdentity: 'rc',
    platform: 'darwin',
    endpoint,
  })
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'kition-product-event/v1',
    id: 'evt_12345678',
    name: 'app_started',
    occurred_at: '2026-07-19T06:00:00.000Z',
    app_version: '1.0.0-beta.3',
    build_identity: 'rc',
    platform: 'macos',
    installation_id: 'anon_12345678',
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  clearProductAnalyticsData()
  configureProductAnalytics({
    enabled: false,
    appVersion: '1.0.0-beta.3',
    buildIdentity: 'dev',
    platform: 'web',
  })
})

describe('product analytics privacy boundary', () => {
  it('keeps the public JSON contract in lockstep with the runtime event list', () => {
    const schema = JSON.parse(readFileSync(resolve('contracts/analytics/product-event.schema.json'), 'utf8'))
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.name.enum).toEqual(PRODUCT_ANALYTICS_EVENT_NAMES)
    for (const forbidden of ['document_name', 'document_path', 'prompt', 'response', 'url', 'email', 'user_id', 'account_id']) {
      expect(Object.keys(schema.properties)).not.toContain(forbidden)
    }
  })

  it('does not create identifiers or queue events before explicit enablement', () => {
    expect(trackProductEvent('app_started')).toBe(false)
    expect(getProductAnalyticsQueue()).toEqual([])
    expect(localStorage.getItem('kition.analytics.installation.v1')).toBeNull()
  })

  it('queues only fixed coarse fields under an analytics-specific anonymous id', () => {
    enable()

    expect(trackProductEvent('provider_choice_selected', {
      result: 'success',
      provider_choice: 'cloud',
      account_state: 'signed_out',
      subscription_state: 'trial',
    })).toBe(true)

    const [event] = getProductAnalyticsQueue()
    expect(event).toMatchObject({
      schema: 'kition-product-event/v1',
      name: 'provider_choice_selected',
      app_version: '1.0.0-beta.3',
      build_identity: 'rc',
      platform: 'macos',
      result: 'success',
      provider_choice: 'cloud',
      account_state: 'signed_out',
      subscription_state: 'trial',
    })
    expect(event.installation_id).toMatch(/^anon_/)
    expect(JSON.stringify(event)).not.toContain('workspace')
    expect(JSON.stringify(event)).not.toContain('prompt')
  })

  it('normalizes billing states without plan names or account identity', () => {
    expect(normalizeAnalyticsSubscriptionState('trialing')).toBe('trial')
    expect(normalizeAnalyticsSubscriptionState('past_due')).toBe('payment_required')
    expect(normalizeAnalyticsSubscriptionState('enterprise_founders')).toBe('unknown')
  })

  it('rejects unknown fields and sensitive values at runtime', () => {
    expect(validateProductAnalyticsEvent(validEvent({
      document_name: 'private.md',
    })).ok).toBe(false)
    expect(validateProductAnalyticsEvent(validEvent({
      installation_id: 'https://private.example.com/member',
    })).ok).toBe(false)
    expect(validateProductAnalyticsEvent(validEvent({
      id: 'token_access_token_secret',
    }))).toEqual({ ok: false, error: 'event contains sensitive data' })
    expect(validateProductAnalyticsEvent(validEvent({ occurred_at: 'July 19, 2026' })).ok).toBe(false)
  })

  it('does not let an untyped caller override core identity fields', () => {
    enable()
    const tracked = trackProductEvent('app_started', {
      name: 'billing_opened',
      installation_id: 'account_12345678',
    } as any)

    expect(tracked).toBe(true)
    expect(getProductAnalyticsQueue()[0]).toMatchObject({
      name: 'app_started',
      installation_id: expect.stringMatching(/^anon_/),
    })
  })

  it('bounds the offline queue and tracks first-use events only once', () => {
    enable()
    expect(trackProductEventOnce('agent_first_request_started')).toBe(true)
    expect(trackProductEventOnce('agent_first_request_started')).toBe(false)
    expect(getProductAnalyticsQueue().filter((event) => event.name === 'agent_first_request_started')).toHaveLength(1)
    for (let index = 0; index < 220; index += 1) {
      trackProductEvent('workspace_opened')
    }

    expect(getProductAnalyticsQueue()).toHaveLength(200)
  })

  it('delivers a batch without blocking and removes only acknowledged events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    enable('https://analytics.kition.ai/v1/events')
    trackProductEvent('app_started')

    await expect(flushProductAnalytics()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://analytics.kition.ai/v1/events',
      expect.objectContaining({ method: 'POST', keepalive: true }),
    )
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(payload.schema).toBe('kition-analytics-batch/v1')
    expect(payload.events).toHaveLength(1)
    expect(getProductAnalyticsQueue()).toEqual([])
  })

  it('refuses non-TLS remote analytics endpoints', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    enable('http://analytics.example.com/v1/events')
    trackProductEvent('app_started')

    await expect(flushProductAnalytics()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getProductAnalyticsQueue()).toHaveLength(1)
  })

  it('keeps events locally on transport failure and clears everything when disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    enable('https://analytics.kition.ai/v1/events')
    trackProductEvent('app_started')

    await expect(flushProductAnalytics()).resolves.toBe(false)
    expect(getProductAnalyticsQueue()).toHaveLength(1)

    configureProductAnalytics({
      enabled: false,
      appVersion: '1.0.0-beta.3',
      buildIdentity: 'rc',
      platform: 'darwin',
    })
    expect(getProductAnalyticsQueue()).toEqual([])
    expect(localStorage.getItem('kition.analytics.installation.v1')).toBeNull()
    expect(localStorage.getItem('kition.analytics.once.v1')).toBeNull()
  })

  it('aborts an in-flight delivery as soon as analytics is disabled', async () => {
    let requestSignal: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init.signal as AbortSignal
      requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
    enable('https://analytics.kition.ai/v1/events')
    trackProductEvent('app_started')

    const pending = flushProductAnalytics()
    await Promise.resolve()
    configureProductAnalytics({
      enabled: false,
      appVersion: '1.0.0-beta.3',
      buildIdentity: 'rc',
      platform: 'darwin',
    })

    expect(requestSignal?.aborted).toBe(true)
    await expect(pending).resolves.toBe(false)
    expect(getProductAnalyticsQueue()).toEqual([])
  })
})
