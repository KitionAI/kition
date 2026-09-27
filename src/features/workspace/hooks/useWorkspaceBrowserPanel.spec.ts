import { describe, expect, it } from 'vitest'

import { shouldReattachBrowserTab } from './useWorkspaceBrowserPanel'

describe('shouldReattachBrowserTab', () => {
  it('never reattaches without a tab, or for an empty tab with no live page', () => {
    expect(shouldReattachBrowserTab(null, { page_url: 'https://a.test', panel_visible: false })).toBe(false)
    expect(shouldReattachBrowserTab({ url: '' }, null)).toBe(false)
    expect(shouldReattachBrowserTab({ url: '  ' }, { page_url: '', panel_visible: false })).toBe(false)
  })

  it('reattaches when the desktop process reports no status or a hidden panel', () => {
    expect(shouldReattachBrowserTab({ url: 'https://a.test' }, null)).toBe(true)
    expect(shouldReattachBrowserTab({ url: 'https://a.test' }, { page_url: 'https://a.test', panel_visible: false })).toBe(true)
    expect(shouldReattachBrowserTab({ url: '' }, { page_url: 'https://live.test', panel_visible: false })).toBe(true)
  })

  it('reattaches when the requested page was lost, and stays put when it is showing', () => {
    expect(shouldReattachBrowserTab({ url: 'https://a.test' }, { page_url: '', panel_visible: true })).toBe(true)
    expect(shouldReattachBrowserTab({ url: 'https://a.test' }, { page_url: 'https://a.test', panel_visible: true })).toBe(false)
    expect(shouldReattachBrowserTab({ url: '' }, { page_url: 'https://live.test', panel_visible: true })).toBe(false)
  })
})
