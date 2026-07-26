import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserView: class {},
  WebContentsView: class {},
  shell: {
    openExternal: vi.fn(),
  },
}))

function createDom(html: string, url = 'https://example.com/') {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
  })
  const { window } = dom
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent || ''
    },
    set(value) {
      this.textContent = String(value || '')
    },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 320,
        bottom: 48,
        width: 320,
        height: 48,
      }
    },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value() {},
  })
  return dom
}

async function runExtractContext(input: {
  command?: string
  entityType?: string
  query?: string
  html: string
  url?: string
}) {
  const mod = await import('./generic-browser-session.mjs')
  const dom = createDom(input.html, input.url)
  const result = mod.__genericBrowserSessionTestUtils.buildPageContextFromHTML({
    html: input.html,
    pageURL: input.url,
    pageTitle: '',
    command: input.command,
    entityType: input.entityType,
    query: input.query,
    maxLinks: 6,
    maxContentLength: 300,
    maxPreviewLength: 300,
  })
  return {
    dom,
    result,
    window: dom.window,
  }
}

describe('generic browser search workflow', () => {
  it('returns a direct blocker for risk verification pages', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const result = mod.__genericBrowserSessionTestUtils.buildSearchWorkflowResultFromPage({
      pageURL: 'https://example.com/blocked',
      pageTitle: 'Security check',
      directURL: 'https://example.com/search?q=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      html: `
        <main>
          <h1>Security check</h1>
          <p>This IP appears risky. Switch to a reliable network and retry.</p>
        </main>
      `,
    })

    expect(result).toMatchObject({
      applied: false,
      reason: 'risk_gate',
      page_title: 'Security check',
    })
    expect(String(result.body_text_preview || '')).toContain('This IP appears risky')
  })

  it('treats a bare risk pass page as a risk gate', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const result = mod.__genericBrowserSessionTestUtils.buildSearchWorkflowResultFromPage({
      pageURL: 'https://example.com/',
      pageTitle: 'risk pass',
      html: `
        <main>
          <p>risk pass</p>
        </main>
      `,
    })

    expect(result).toMatchObject({
      applied: false,
      reason: 'risk_gate',
      page_title: 'risk pass',
    })
  })

  it('treats an existing search page as ready without injecting page scripts', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const result = mod.__genericBrowserSessionTestUtils.buildSearchWorkflowResultFromPage({
      pageURL: 'https://example.com/search?keyword=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      pageTitle: 'Search results',
      html: '<main><div>Search results</div></main>',
    })

    expect(result).toMatchObject({
      applied: true,
      reason: 'already_on_search_page',
    })
  })

  it('does not synthesize a host-specific direct search results url', async () => {
    const mod = await import('./generic-browser-session.mjs')

    expect(
      mod.__genericBrowserSessionTestUtils.resolveDirectSearchResultsURL({
        adapter: 'generic-web',
        host: 'x.com',
        query: 'San Diego travel',
      }),
    ).toBe('')
  })

  it('prefers an explicit search results url when one is already provided', async () => {
    const mod = await import('./generic-browser-session.mjs')

    expect(
      mod.__genericBrowserSessionTestUtils.resolveDirectSearchResultsURL({
        host: 'youtube.com',
        query: 'San Diego travel',
        url: 'https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      }),
    ).toBe('https://www.youtube.com/results?search_query=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8')
  })

  it('blocks automatic search when the site does not expose a direct search results url', async () => {
    const mod = await import('./generic-browser-session.mjs')

    expect(
      mod.__genericBrowserSessionTestUtils.buildSearchWorkflowResultFromPage({
        pageURL: 'https://unknown.example.com/',
        pageTitle: 'Home',
        html: '<main><div>Welcome</div></main>',
        directURL: '',
      }),
    ).toMatchObject({
      applied: false,
      reason: 'search_url_unavailable',
      page_url: 'https://unknown.example.com/',
    })
  })

  it('clears stale search workflow runtime when switching to a different site host', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const session = {
      lastRuntime: {
        search_workflow: {
          stage: 'blocked',
          reason: 'risk_gate',
        },
        navigation: {
          stage: 'loaded',
        },
      },
    }

    expect(
      mod.__genericBrowserSessionTestUtils.resolveURLHost(
        'https://x.com/search?q=%E4%B8%89%E4%BA%9A',
      ),
    ).toBe('x.com')
    expect(
      mod.__genericBrowserSessionTestUtils.resolveURLHost('https://youtube.com/'),
    ).toBe('youtube.com')

    mod.__genericBrowserSessionTestUtils.resetSearchWorkflowRuntime(session)

    expect(session.lastRuntime).toEqual({
      navigation: {
        stage: 'loaded',
      },
    })
  })

  it('filters extracted list candidates by the exact search query context', async () => {
    const run = await runExtractContext({
      command: 'search',
      entityType: 'note',
      query: 'San Diego travel',
      url: 'https://example.com/search?keyword=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      html: `
        <body>
          <main>
            <article>
              <a href="/explore/1">San Diego travel guide for a four-day trip</a>
              <div>A practical guide for first-time visitors</div>
            </article>
            <article>
              <a href="/explore/2">Portland coffee shop map</a>
              <div>Saved weekend city walk</div>
            </article>
            <article>
              <a href="/explore/3">San Diego travel hotel guide</a>
              <div>Downtown and La Jolla compared</div>
            </article>
          </main>
        </body>
      `,
    })

    expect(run.result.page_type).toBe('list')
    expect(run.result.extracted_entities).toHaveLength(2)
    expect(run.result.extracted_entities.map((item: { title?: string }) => item.title)).toEqual([
      'San Diego travel guide for a four-day trip',
      'San Diego travel hotel guide',
    ])
    run.dom.window.close()
  })

  it('passes the requested query into runtime page-context extraction', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const manager = new mod.GenericBrowserSessionManager(null, () => null)
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } }
      }
      if (method === 'DOM.getOuterHTML') {
        return {
          outerHTML: `
            <html>
              <body>
                <main>
                  <article><a href="/explore/1">San Diego travel guide for a four-day trip</a></article>
                  <article><a href="/explore/2">Portland coffee shop map</a></article>
                </main>
              </body>
            </html>
          `,
        }
      }
      return {}
    })

    manager.ensureSession = vi.fn(async () => ({ profileId: 'default' }))
    manager.getSessionWebContents = vi.fn(() => ({
      isDestroyed: () => false,
      getURL: () => 'https://example.com/search?keyword=%E4%B8%89%E4%BA%9A%E6%97%85%E6%B8%B8',
      getTitle: () => 'Search results',
      setUserAgent: vi.fn(),
      executeJavaScript: vi.fn(async () => ({ primed: true })),
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
      },
    }))
    manager.configureSessionDebugger = vi.fn(async () => {})

    const result = await manager.extractPageContext({
      profile_id: 'default',
      command: 'search',
      query: 'San Diego travel',
      entity_type: 'note',
    })

    expect(result.profile_id).toBe('default')
    expect(sendCommand).toHaveBeenCalledWith('DOM.getDocument', {
      depth: 1,
      pierce: false,
    })
    expect(result.extraction_prime).toMatchObject({ primed: true })
    expect(result.extracted_entities).toHaveLength(1)
  })

  it('keeps scanning past navigation links to extract list-page content cards', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const manager = new mod.GenericBrowserSessionManager(null, () => null)
    const navLinks = Array.from({ length: 24 }, (_, index) =>
      `<a class="nav-link" href="/nav/${index + 1}">Navigation ${index + 1}</a>`,
    ).join('')
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } }
      }
      if (method === 'DOM.getOuterHTML') {
        return {
          outerHTML: `
            <html>
              <body>
                <header>${navLinks}</header>
                <main>
                  <article><a href="/video/1">An interview about living well</a></article>
                  <article><a href="/video/2">Original animated music video</a></article>
                  <article><a href="/video/3">A character story that changed everything</a></article>
                </main>
              </body>
            </html>
          `,
        }
      }
      return {}
    })

    manager.ensureSession = vi.fn(async () => ({ profileId: 'default' }))
    manager.getSessionWebContents = vi.fn(() => ({
      isDestroyed: () => false,
      getURL: () => 'https://www.youtube.com/',
      getTitle: () => 'youtube',
      setUserAgent: vi.fn(),
      executeJavaScript: vi.fn(async () => ({ primed: true })),
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
      },
    }))
    manager.configureSessionDebugger = vi.fn(async () => {})

    const result = await manager.extractPageContext({
      profile_id: 'default',
      command: '',
      query: '',
      entity_type: 'video',
    })

    expect(result.page_type).toBe('list')
    expect(result.extracted_entities).toHaveLength(3)
    expect(result.extracted_entities.map((item: { title?: string }) => item.title)).toEqual([
      'An interview about living well',
      'Original animated music video',
      'A character story that changed everything',
    ])
    expect(result.extracted_entities[0]).toMatchObject({
      summary: expect.stringContaining('An interview about living well'),
    })
  })

  it('continues extracting page context when script priming is unsupported', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const manager = new mod.GenericBrowserSessionManager(null, () => null)
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } }
      }
      if (method === 'DOM.getOuterHTML') {
        return {
          outerHTML: `
            <html>
              <body>
                <main>
                  <article><a href="/video/1">Test video 1</a></article>
                </main>
              </body>
            </html>
          `,
        }
      }
      return {}
    })
    manager.ensureSession = vi.fn(async () => ({ profileId: 'default' }))
    manager.getSessionWebContents = vi.fn(() => ({
      isDestroyed: () => false,
      getURL: () => 'https://www.youtube.com/',
      getTitle: () => 'youtube',
      setUserAgent: vi.fn(),
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
      },
    }))
    manager.configureSessionDebugger = vi.fn(async () => {})

    const result = await manager.extractPageContext({
      profile_id: 'default',
      command: '',
      query: '',
      entity_type: 'video',
    })

    expect(result.extraction_prime).toMatchObject({ primed: false })
    expect(result.extracted_entities).toHaveLength(1)
  })

  it('returns control even if page navigation keeps pending', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const manager = new mod.GenericBrowserSessionManager(null, () => null)
    const session = {
      profileId: 'default',
      lastRequestedURL: '',
      lastRuntime: {},
      lastError: '',
    }
    const loadURL = vi.fn(() => new Promise(() => {}))
    const webContents = {
      getURL: () => '',
      getTitle: () => '',
      focus: vi.fn(),
      loadURL,
    }

    manager.ensureSession = vi.fn(async () => session)
    manager.attachPanel = vi.fn()
    manager.getSessionWebContents = vi.fn(() => webContents)
    manager.configureSessionDebugger = vi.fn(async () => {})
    manager.emitPanelState = vi.fn()
    manager.status = vi.fn(async () => ({
      profile_id: 'default',
      supported: true,
      available: true,
      window_open: true,
      logged_in: false,
      editor_ready: false,
      page_url: '',
      page_title: '',
      message: '',
      last_error: session.lastError,
      runtime: session.lastRuntime,
    }))

    const startedAt = Date.now()
    const result = await manager.ensureWindow({
      profile_id: 'default',
      url: 'https://example.com',
      navigation_timeout_ms: 10,
    })

    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(loadURL).toHaveBeenCalledWith('https://example.com')
    expect(result.last_error).toBe('')
    expect(result.runtime?.navigation).toMatchObject({
      stage: 'pending',
      requested_url: 'https://example.com',
    })
  })

  it('opens the page without attaching the CDP debugger', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const manager = new mod.GenericBrowserSessionManager(null, () => null)
    const session = {
      profileId: 'default',
      lastRequestedURL: '',
      lastRuntime: {},
      lastError: '',
    }
    const loadURL = vi.fn(async () => {})
    const webContents = {
      getURL: () => '',
      getTitle: () => '',
      focus: vi.fn(),
      loadURL,
    }

    manager.ensureSession = vi.fn(async () => session)
    manager.attachPanel = vi.fn()
    manager.getSessionWebContents = vi.fn(() => webContents)
    manager.configureSessionDebugger = vi.fn(async () => {})
    manager.emitPanelState = vi.fn()
    manager.status = vi.fn(async () => ({
      profile_id: 'default',
      supported: true,
      available: true,
      window_open: true,
      logged_in: false,
      editor_ready: false,
      page_url: '',
      page_title: '',
      message: '',
      last_error: session.lastError,
      runtime: session.lastRuntime,
    }))

    const result = await manager.ensureWindow({
      profile_id: 'default',
      url: 'https://example.com',
      navigation_timeout_ms: 10,
    })

    expect(loadURL).toHaveBeenCalledWith('https://example.com')
    expect(manager.configureSessionDebugger).not.toHaveBeenCalled()
    expect(result.runtime?.debugger).toBeUndefined()
  })

  it('creates a live session without attaching the CDP debugger', async () => {
    const mod = await import('./generic-browser-session.mjs')
    const configureSession = vi.fn(async () => {})
    const manager = new mod.GenericBrowserSessionManager(null, () => null, {
      configureSession,
    })
    const setUserAgent = vi.fn()
    const partitionSession = {}
    const fakeWebContents = {
      isDestroyed: () => false,
      session: partitionSession,
      setWindowOpenHandler: vi.fn(),
      setUserAgent,
      on: vi.fn(),
    }
    const fakeView = {
      webContents: fakeWebContents,
    }

    manager.createSessionSurface = vi.fn(() => ({
      surfaceType: 'webcontents_view',
      view: fakeView,
    }))
    manager.configureSessionDebugger = vi.fn(() => new Promise(() => {}))

    const session = await manager.ensureSession('default')

    expect(session.view).toBe(fakeView)
    expect(configureSession).toHaveBeenCalledWith(partitionSession)
    expect(setUserAgent).toHaveBeenCalledTimes(1)
    expect(manager.configureSessionDebugger).not.toHaveBeenCalled()
  })
})

describe('resolveAddressBarURL', () => {
  const resolve = async (input: string) => {
    const mod = await import('./generic-browser-session.mjs')
    return mod.__genericBrowserSessionTestUtils.resolveAddressBarURL(input)
  }

  it('passes through an explicit scheme URL unchanged', async () => {
    expect(await resolve('https://www.youtube.com/feed/trending')).toBe('https://www.youtube.com/feed/trending')
    expect(await resolve('  http://example.com/path  ')).toBe('http://example.com/path')
  })

  it('upgrades a bare domain to https', async () => {
    expect(await resolve('example.com')).toBe('https://example.com')
    expect(await resolve('localhost:3000')).toBe('https://localhost:3000')
  })

  it('builds a web search url for free-text queries', async () => {
    expect(await resolve('San Diego travel guide')).toBe(
      'https://www.bing.com/search?q=San%20Diego%20travel%20guide',
    )
  })

  it('returns an empty string for blank input', async () => {
    expect(await resolve('   ')).toBe('')
  })
})

describe('generic browser navigation commands', () => {
  const freshManager = async () => {
    const mod = await import('./generic-browser-session.mjs')
    return new mod.GenericBrowserSessionManager(null, () => null)
  }

  it('treats goBack/goForward/reload/stop as no-ops without a live view', async () => {
    const manager = await freshManager()
    const emitSpy = vi.spyOn(manager, 'emitPanelState')

    for (const status of [
      await manager.goBack({ profile_id: 'default' }),
      await manager.goForward({ profile_id: 'default' }),
      await manager.reload({ profile_id: 'default' }),
      await manager.stop({ profile_id: 'default' }),
    ]) {
      expect(status).toMatchObject({
        window_open: false,
        can_go_back: false,
        can_go_forward: false,
        is_loading: false,
      })
    }

    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('drives the navigation history when a live view is present', async () => {
    const manager = await freshManager()
    const navigationHistory = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(),
      goForward: vi.fn(),
    }
    const webContents = {
      isDestroyed: () => false,
      navigationHistory,
      reload: vi.fn(),
      stop: vi.fn(),
    }
    const session = { profileId: 'default', isLoading: true }
    manager.getSession = vi.fn(() => session)
    manager.getSessionWebContents = vi.fn(() => webContents)
    manager.emitPanelState = vi.fn()
    manager.status = vi.fn(async () => ({ profile_id: 'default' }))

    await manager.goBack({ profile_id: 'default' })
    await manager.goForward({ profile_id: 'default' })
    await manager.reload({ profile_id: 'default' })
    await manager.stop({ profile_id: 'default' })

    expect(navigationHistory.goBack).toHaveBeenCalledTimes(1)
    expect(navigationHistory.goForward).toHaveBeenCalledTimes(1)
    expect(webContents.reload).toHaveBeenCalledTimes(1)
    expect(webContents.stop).toHaveBeenCalledTimes(1)
    expect(session.isLoading).toBe(false)
    expect(manager.emitPanelState).toHaveBeenCalledTimes(4)
  })
})
