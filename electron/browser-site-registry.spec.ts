import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.fn()
const writeFile = vi.fn()

vi.mock('node:fs/promises', () => ({
  default: {
    readFile,
    writeFile,
  },
}))

async function loadRegistry() {
  vi.resetModules()
  return import('./browser-site-registry.mjs')
}

describe('BrowserSiteRegistry', () => {
  beforeEach(() => {
    readFile.mockReset()
    writeFile.mockReset()
    writeFile.mockResolvedValue(undefined)
  })

  it('starts empty when the registry file is missing', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()
    expect(registry.listSites()).toEqual([])
  })

  it('starts empty when the registry file is corrupt', async () => {
    readFile.mockResolvedValue('not-json{')
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()
    expect(registry.listSites()).toEqual([])
  })

  it('records a visit with a normalized host and increments visit count', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()

    registry.upsertVisit({ url: 'https://www.Example.com/page', title: 'Example', provider: 'generic-web' })
    registry.upsertVisit({ url: 'https://example.com/other', title: 'Example 2' })

    const sites = registry.listSites()
    expect(sites).toHaveLength(1)
    expect(sites[0].host).toBe('example.com')
    expect(sites[0].visitCount).toBe(2)
    expect(sites[0].title).toBe('Example 2')
  })

  it('ignores non-http urls with no resolvable host', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()

    expect(registry.upsertVisit({ url: 'about:blank' })).toBeNull()
    expect(registry.listSites()).toEqual([])
  })

  it('sets login status only on existing records', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()

    registry.upsertVisit({ url: 'https://example.com', profileId: 'default' })
    registry.setLoginStatus('example.com', 'default', true)
    expect(registry.getSite('example.com', 'default')?.loggedIn).toBe(true)

    registry.setLoginStatus('missing.com', 'default', true)
    expect(registry.getSite('missing.com', 'default')).toBeNull()
  })

  it('forgets all profiles for a host when no profile is given', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()

    registry.upsertVisit({ url: 'https://example.com', profileId: 'a' })
    registry.upsertVisit({ url: 'https://example.com', profileId: 'b' })
    registry.upsertVisit({ url: 'https://other.com', profileId: 'a' })

    const removed = registry.forgetSite('example.com')
    expect(removed).toHaveLength(2)
    expect(registry.listSites().map((site) => site.host)).toEqual(['other.com'])
  })

  it('never persists cookie values or credentials', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const { BrowserSiteRegistry } = await loadRegistry()
    const registry = new BrowserSiteRegistry({ data_dir: '/tmp/kition' })
    await registry.load()

    registry.upsertVisit({ url: 'https://example.com', title: 'Example' })
    registry.setLoginStatus('example.com', 'default', true)
    await registry.flushNow()

    expect(writeFile).toHaveBeenCalled()
    const payload = writeFile.mock.calls.at(-1)?.[1] ?? ''
    const parsed = JSON.parse(payload)
    const fields = Object.keys(parsed.sites[0])
    expect(fields).not.toContain('cookies')
    expect(fields).not.toContain('cookie')
    expect(fields).not.toContain('password')
    expect(fields).toEqual(
      expect.arrayContaining(['host', 'profileId', 'loggedIn', 'lastSeenAt']),
    )
  })
})
