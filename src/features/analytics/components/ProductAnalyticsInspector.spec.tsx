import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearProductAnalyticsData,
  configureProductAnalytics,
  trackProductEvent,
} from '@/features/analytics/lib/productAnalytics'
import { ProductAnalyticsInspector } from './ProductAnalyticsInspector'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  localStorage.clear()
  clearProductAnalyticsData()
  configureProductAnalytics({
    enabled: true,
    appVersion: '1.0.0-beta.3',
    buildIdentity: 'dev',
    platform: 'web',
  })
  trackProductEvent('app_started')
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  configureProductAnalytics({
    enabled: false,
    appVersion: '1.0.0-beta.3',
    buildIdentity: 'dev',
    platform: 'web',
  })
})

describe('ProductAnalyticsInspector', () => {
  it('shows the exact local event names and clears the queue', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(ProductAnalyticsInspector))
    })

    expect(container.textContent).toContain('1 events waiting on this device.')
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Recent events'))
        ?.click()
    })
    expect(container.querySelector('[data-testid="analytics-event-inspector"]')?.textContent)
      .toContain('app_started')
    await act(async () => {
      (container.querySelector('[data-testid="analytics-event-inspector"] summary') as HTMLElement).click()
    })
    const payload = container.querySelector('[data-testid="analytics-event-inspector"] pre')?.textContent || ''
    expect(payload).toContain('"schema": "kition-product-event/v1"')
    expect(payload).not.toContain('http://')

    await act(async () => {
      (container.querySelector('[data-testid="clear-analytics-events"]') as HTMLButtonElement).click()
    })
    expect(container.textContent).toContain('0 events waiting on this device.')
    expect((container.querySelector('[data-testid="clear-analytics-events"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
