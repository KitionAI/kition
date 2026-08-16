import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadDesktopModule() {
  vi.resetModules()
  return import('./desktop')
}

describe('desktop service helpers', () => {
  beforeEach(() => {
    (window as typeof window & { kitionDesktop?: unknown }).kitionDesktop = undefined
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    (window as typeof window & { kitionDesktop?: unknown }).kitionDesktop = undefined
    window.localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('normalizes API paths consistently', async () => {
    const { normalizeApiPath, resolveApiURL } = await loadDesktopModule()

    expect(normalizeApiPath('/api/v1/auth/me')).toBe('/v1/auth/me')
    expect(normalizeApiPath('v1/auth/me')).toBe('/v1/auth/me')
    expect(normalizeApiPath('/v1/auth/me')).toBe('/v1/auth/me')
    expect(resolveApiURL('/v1/auth/me')).toBe('/api/v1/auth/me')
  })

  it('resolves bundled template assets against the renderer instead of the runtime API', async () => {
    const desktopWindow = window as typeof window & { kitionDesktop?: unknown }
    desktopWindow.kitionDesktop = { shell: 'electron' }
    const { resolvePublicFileURL } = await loadDesktopModule()

    expect(resolvePublicFileURL('kition-bundled:/templates/example/image.png'))
      .toBe('kition-bundled://assets/templates/example/image.png')
    expect(resolvePublicFileURL('/uploads/example/image.png'))
      .toBe('http://127.0.0.1:18101/uploads/example/image.png')
  })

  it('switches API base URLs for desktop runtime', async () => {
    const { getApiBaseURL } = await loadDesktopModule()
    expect(getApiBaseURL()).toBe('/api')

    ;(window as typeof window & { kitionDesktop?: unknown }).kitionDesktop = { shell: 'electron' }

    const desktopModule = await loadDesktopModule()
    expect(desktopModule.getApiBaseURL()).toBe('http://127.0.0.1:18101/api')
  })

  it('detects the electron desktop runtime from the dedicated bridge', async () => {
    (window as typeof window & { kitionDesktop?: Record<string, unknown> }).kitionDesktop = {
      shell: 'electron',
    }

    const { isElectronDesktopRuntime } = await loadDesktopModule()
    expect(isElectronDesktopRuntime()).toBe(true)
  })

  it('selects a read-only local analysis source through the desktop bridge', async () => {
    const source = {
      id: 'source-project',
      label: 'project',
      root_path: '/example/project',
      access: 'read',
    }
    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      ChooseAgentAnalysisDirectory: vi.fn().mockResolvedValue(source),
    }

    const desktopModule = await loadDesktopModule()
    await expect(desktopModule.chooseAgentAnalysisDirectory('../project')).resolves.toEqual(source)
    expect((window as any).kitionDesktop.ChooseAgentAnalysisDirectory)
      .toHaveBeenCalledWith({ suggested_path: '../project' })
  })

  it('subscribes to normalized workspace document external changes', async () => {
    const off = vi.fn()
    let eventCallback: ((payload: unknown) => void) | undefined
    const eventsOn = vi.fn((_eventName: string, callback: (payload: unknown) => void) => {
      eventCallback = callback
      return off
    })
    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      documentExternalChangeEvent: 'desktop:document:external-change',
      EventsOn: eventsOn,
    }

    const { subscribeWorkspaceDocumentExternalChanges } = await loadDesktopModule()
    const handler = vi.fn()
    const unsubscribe = subscribeWorkspaceDocumentExternalChanges(handler)

    expect(eventsOn).toHaveBeenCalledWith(
      'desktop:document:external-change',
      expect.any(Function),
    )
    eventCallback?.({ path: 'notes\\today.md', eventType: 'change', mtimeMs: 42 })
    expect(handler).toHaveBeenCalledWith({
      path: 'notes/today.md',
      eventType: 'change',
      mtimeMs: 42,
    })

    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('waits for the embedded desktop backend health endpoint', async () => {
    vi.useFakeTimers()
    ;(window as typeof window & { kitionDesktop?: unknown }).kitionDesktop = { shell: 'electron' }

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('booting'))
      .mockResolvedValueOnce({ ok: true })

    vi.stubGlobal('fetch', fetchMock)

    const { waitForDesktopBackendReady } = await loadDesktopModule()
    const readiness = waitForDesktopBackendReady(1_000)

    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(300)

    await expect(readiness).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18101/health', { method: 'GET' })
  })

  it('short-circuits backend waits outside desktop runtime', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { waitForDesktopBackendReady } = await loadDesktopModule()
    await expect(waitForDesktopBackendReady()).resolves.toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats skip_api desktop launches as ready without polling health', async () => {
    const backendStatus = {
      base_url: 'http://127.0.0.1:18101',
      health_url: '',
      running: true,
      last_error: '',
      logs: '',
      log_file: '',
      launch_mode: 'skip_api',
      binary_path: '',
      config_path: '',
      working_dir: '',
      command: '',
    }

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      BackendStatus: vi.fn().mockResolvedValue(backendStatus),
    }

    const { waitForDesktopBackendReady } = await loadDesktopModule()
    await expect(waitForDesktopBackendReady()).resolves.toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries starting the desktop backend when status reports it is not running', async () => {
    vi.useFakeTimers()

    const backendStatus = {
      base_url: 'http://127.0.0.1:18101',
      health_url: 'http://127.0.0.1:18101/health',
      running: false,
      last_error: 'backend stopped',
      logs: '',
      log_file: '',
      launch_mode: 'env_binary',
      binary_path: '',
      config_path: '',
      working_dir: '',
      command: '',
    }

    const retryMock = vi.fn().mockResolvedValue({
      ...backendStatus,
      running: true,
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      BackendStatus: vi.fn().mockResolvedValue(backendStatus),
      RetryBackendStart: retryMock,
    }

    const { waitForDesktopBackendReady } = await loadDesktopModule()
    const readiness = waitForDesktopBackendReady(1_000)

    await vi.advanceTimersByTimeAsync(10)

    await expect(readiness).resolves.toBe(true)
    expect(retryMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18101/health', { method: 'GET' })
  })

  it('does not cache desktop backend readiness forever after a prior success', async () => {
    vi.useFakeTimers()
    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      BackendStatus: vi.fn().mockResolvedValue(null),
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { waitForDesktopBackendReady } = await loadDesktopModule()

    await expect(waitForDesktopBackendReady(1_000)).resolves.toBe(true)
    await expect(waitForDesktopBackendReady(1_000)).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('proxies generic browser session helpers through the desktop bridge', async () => {
    const status = {
      provider: 'generic-web',
      supported: true,
      available: true,
      window_open: true,
      logged_in: true,
      editor_ready: false,
      page_url: 'https://www.youtube.com/feed/trending',
      page_title: 'YouTube Trending',
      message: 'ready',
      last_error: '',
    }
    const pageContext = {
      provider: 'generic-web',
      supported_page: true,
      logged_in: true,
      editor_ready: false,
      page_url: 'https://www.youtube.com/feed/trending',
      page_title: 'YouTube Trending',
      hostname: 'youtube.com',
      page_heading: 'Markets',
      content_text_preview: 'Body text preview',
      extracted_at: '2026-05-15T10:00:00.000Z',
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      BrowserSessionStatus: vi.fn().mockResolvedValue(status),
      EnsureBrowserSessionWindow: vi.fn().mockResolvedValue(status),
      OpenBrowserSessionHome: vi.fn().mockResolvedValue(status),
      HideBrowserSessionPanel: vi.fn().mockResolvedValue({
        ...status,
        window_open: false,
        panel_visible: false,
        panel_width: 0,
      }),
      SetBrowserSessionHostLayout: vi.fn().mockResolvedValue(status),
      ExtractBrowserPageContext: vi.fn().mockResolvedValue(pageContext),
    }

    const desktopModule = await loadDesktopModule()

    await expect(
      desktopModule.getBrowserSessionStatus({ provider: 'generic-web' }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      page_url: 'https://www.youtube.com/feed/trending',
    })
    await expect(
      desktopModule.ensureBrowserSessionWindow({ provider: 'generic-web' }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      logged_in: true,
    })
    await expect(
      desktopModule.openBrowserSessionHome({ provider: 'generic-web' }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      supported: true,
    })
    await expect(
      desktopModule.hideBrowserSessionPanel({ provider: 'generic-web' }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      panel_visible: false,
    })
    await expect(
      desktopModule.setBrowserSessionHostLayout({
        provider: 'generic-web',
        leftInset: 272,
        topInset: 98,
        rightInset: 392,
      }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      logged_in: true,
    })
    await expect(
      desktopModule.extractBrowserPageContext({
        provider: 'generic-web',
        max_preview_length: 800,
      }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      hostname: 'youtube.com',
    })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.BrowserSessionStatus).toHaveBeenCalledWith({
      provider: 'generic-web',
    })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.ExtractBrowserPageContext).toHaveBeenCalledWith({
      provider: 'generic-web',
      max_preview_length: 800,
    })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.SetBrowserSessionHostLayout).toHaveBeenCalledWith({
      provider: 'generic-web',
      leftInset: 272,
      topInset: 98,
      rightInset: 392,
    })
  })

  it('forwards generic-web session targets through the desktop bridge', async () => {
    const status = {
      provider: 'generic-web',
      supported: true,
      available: true,
      window_open: true,
      logged_in: true,
      editor_ready: false,
      page_url: 'https://example.com/list',
      page_title: 'Example List',
      message: 'ready',
      last_error: '',
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      EnsureBrowserSessionWindow: vi.fn().mockResolvedValue(status),
    }

    const desktopModule = await loadDesktopModule()

    await expect(
      desktopModule.ensureBrowserSessionWindow({
        provider: 'generic-web',
        host: 'example.com',
        url: 'https://example.com/list',
      }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      page_url: 'https://example.com/list',
    })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.EnsureBrowserSessionWindow).toHaveBeenCalledWith({
      provider: 'generic-web',
      host: 'example.com',
      url: 'https://example.com/list',
    })
  })

  it('normalizes generic-web structured page entities from the desktop bridge', async () => {
    const pageContext = {
      provider: 'generic-web',
      supported_page: true,
      logged_in: true,
      editor_ready: false,
      page_url: 'https://example.com/list',
      page_title: 'Example List',
      hostname: 'example.com',
      page_type: 'list',
      extracted_entities: [
        {
          entity_type: 'post',
          url: 'https://example.com/post-1',
          title: 'Post One',
          summary: 'First post summary',
        },
      ],
      extracted_at: '2026-05-15T10:00:00.000Z',
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      ExtractBrowserPageContext: vi.fn().mockResolvedValue(pageContext),
    }

    const desktopModule = await loadDesktopModule()

    await expect(
      desktopModule.extractBrowserPageContext({
        provider: 'generic-web',
        command: 'extract-list',
        entity_type: 'post',
      }),
    ).resolves.toMatchObject({
      provider: 'generic-web',
      page_type: 'list',
      extracted_entities: [
        {
          entity_type: 'post',
          url: 'https://example.com/post-1',
          title: 'Post One',
        },
      ],
    })
  })

  it('subscribes browser session panel state through the generic desktop event', async () => {
    const payload = {
      provider: 'generic-web',
      panel_visible: true,
      panel_width: 560,
      page_title: 'YouTube Trending',
      page_url: 'https://www.youtube.com/feed/trending',
    }
    const eventsOn = vi.fn((eventName: string, callback: (data: unknown) => void) => {
      if (eventName === 'desktop:browser:session-state-updated') {
        callback(payload)
      }
    })

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      EventsOn: eventsOn,
    }

    const desktopModule = await loadDesktopModule()
    const handler = vi.fn()

    desktopModule.registerBrowserSessionStateHandler('generic-web', handler)

    expect(eventsOn).toHaveBeenCalledWith(
      'desktop:browser:session-state-updated',
      expect.any(Function),
    )
    expect(handler).toHaveBeenCalledWith({
      provider: 'generic-web',
      visible: true,
      width: 560,
      title: 'YouTube Trending',
      url: 'https://www.youtube.com/feed/trending',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    })
  })

  it('binds the browser session desktop event only once and fans out to matching handlers', async () => {
    let browserSessionCallback: ((data: unknown) => void) | null = null
    const eventsOn = vi.fn((eventName: string, callback: (data: unknown) => void) => {
      if (eventName === 'desktop:browser:session-state-updated') {
        browserSessionCallback = callback
      }
    })

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      EventsOn: eventsOn,
    }

    const desktopModule = await loadDesktopModule()
    const webHandler = vi.fn()

    const offWeb = desktopModule.registerBrowserSessionStateHandler('generic-web', webHandler)

    expect(eventsOn).toHaveBeenCalledTimes(1)
    expect(eventsOn).toHaveBeenCalledWith(
      'desktop:browser:session-state-updated',
      expect.any(Function),
    )

    browserSessionCallback?.({
      provider: 'generic-web',
      panel_visible: true,
      panel_width: 440,
      page_title: 'Search results',
      page_url: 'https://www.youtube.com/results?search_query=test',
    })

    expect(webHandler).toHaveBeenCalledWith({
      provider: 'generic-web',
      visible: true,
      width: 440,
      title: 'Search results',
      url: 'https://www.youtube.com/results?search_query=test',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    })

    offWeb()
  })

  it('keeps runtime and visibility details on browser session state events', async () => {
    const payload = {
      provider: 'generic-web',
      panel_visible: true,
      panel_width: 420,
      window_open: true,
      logged_in: true,
      message: 'Opened youtube.com',
      page_title: 'YouTube',
      page_url: 'https://www.youtube.com/',
      runtime: {
        navigation: {
          stage: 'loading',
        },
      },
    }
    const eventsOn = vi.fn((eventName: string, callback: (data: unknown) => void) => {
      if (eventName === 'desktop:browser:session-state-updated') {
        callback(payload)
      }
    })

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      EventsOn: eventsOn,
    }

    const desktopModule = await loadDesktopModule()
    const handler = vi.fn()

    desktopModule.registerBrowserSessionStateHandler('generic-web', handler)

    expect(handler).toHaveBeenCalledWith({
      provider: 'generic-web',
      visible: true,
      width: 420,
      windowOpen: true,
      loggedIn: true,
      message: 'Opened youtube.com',
      title: 'YouTube',
      url: 'https://www.youtube.com/',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      runtime: {
        navigation: {
          stage: 'loading',
        },
      },
    })
  })

  it('normalizes Electron platform identifiers from the desktop bridge', async () => {
    (window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      DesktopInfo: vi.fn().mockResolvedValue({
        is_desktop: true,
        platform: 'win32',
        backend_base_url: 'http://127.0.0.1:18101/api',
        data_dir: '/tmp/data',
        cache_dir: '/tmp/cache',
        logs_dir: '/tmp/logs',
        uploads_dir: '/tmp/uploads',
        exports_dir: '/tmp/exports',
        supports_secure_storage: true,
      }),
    }

    const desktopModule = await loadDesktopModule()
    await expect(desktopModule.getDesktopInfo()).resolves.toMatchObject({
      platform: 'windows',
    })
  })

  it('proxies desktop file export helpers through the Electron bridge', async () => {
    (window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      SaveTextFile: vi.fn().mockResolvedValue('/tmp/exports/doc.md'),
      SaveBinaryFile: vi.fn().mockResolvedValue('/tmp/exports/doc.docx'),
      SavePdfFile: vi.fn().mockResolvedValue('/tmp/exports/doc.pdf'),
      CopyDocumentHtml: vi.fn().mockResolvedValue(true),
      CopyImage: vi.fn().mockResolvedValue(true),
      SubmitFeedback: vi.fn().mockResolvedValue({
        ticket_id: 'ticket-123',
        accepted_at: '2026-08-09T12:00:00Z',
      }),
    }

    const desktopModule = await loadDesktopModule()

    await expect(
      desktopModule.saveTextFile({
        dialogTitle: 'Export Markdown',
        defaultFilename: 'doc.md',
        content: '# Doc',
      }),
    ).resolves.toBe('/tmp/exports/doc.md')
    await expect(
      desktopModule.saveBinaryFile({
        dialogTitle: 'Export Word',
        defaultFilename: 'doc.docx',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toBe('/tmp/exports/doc.docx')
    await expect(
      desktopModule.savePdfFile({
        dialogTitle: 'Export PDF',
        defaultFilename: 'doc.pdf',
        html: '<main>Doc</main>',
        pageFormat: 'a4',
        documentPath: 'docs/doc.md',
        landscape: true,
        marginsType: 2,
        scaleFactor: 80,
      }),
    ).resolves.toBe('/tmp/exports/doc.pdf')
    await expect(
      desktopModule.copyDocumentHtmlToClipboard({
        html: '<article><p>Doc</p></article>',
        text: 'Doc',
        documentPath: 'docs/doc.md',
      }),
    ).resolves.toBe(true)
    await expect(
      desktopModule.copyImageToClipboard('http://127.0.0.1:18101/uploads/image.png'),
    ).resolves.toBe(true)
    await expect(desktopModule.submitFeedbackReport({
      description: 'Please improve the feedback workflow.',
      contact_email: 'user@example.com',
      access_token: 'portal-token',
    })).resolves.toEqual({
      ticket_id: 'ticket-123',
      accepted_at: '2026-08-09T12:00:00Z',
    })

    const bridge = (window as typeof window & { kitionDesktop?: any }).kitionDesktop
    expect(bridge.SaveTextFile).toHaveBeenCalledWith('Export Markdown', 'doc.md', '# Doc')
    expect(bridge.SaveBinaryFile).toHaveBeenCalledWith(expect.objectContaining({
      base64_content: 'AQID',
      default_filename: 'doc.docx',
      dialog_title: 'Export Word',
    }))
    expect(bridge.SavePdfFile).toHaveBeenCalledWith({
      dialog_title: 'Export PDF',
      default_filename: 'doc.pdf',
      document_path: 'docs/doc.md',
      html: '<main>Doc</main>',
      page_format: 'a4',
      landscape: true,
      margins_type: 2,
      scale_factor: 80,
    })
    expect(bridge.CopyDocumentHtml).toHaveBeenCalledWith({
      document_path: 'docs/doc.md',
      html: '<article><p>Doc</p></article>',
      text: 'Doc',
    })
    expect(bridge.CopyImage).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:18101/uploads/image.png',
    })
    expect(bridge.SubmitFeedback).toHaveBeenCalledWith({
      description: 'Please improve the feedback workflow.',
      contact_email: 'user@example.com',
      access_token: 'portal-token',
    })
  })

  it('converts unsupported desktop images to PNG before retrying clipboard copy', async () => {
    const copyImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('image data is empty'))
      .mockResolvedValueOnce(true)
    const closeBitmap = vi.fn()
    const drawImage = vi.fn()

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      CopyImage: copyImage,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['webp-image'], { type: 'image/webp' }),
    }))
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({
      width: 2,
      height: 3,
      close: closeBitmap,
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['png-image'], { type: 'image/png' }))
    })

    const { copyImageToClipboard } = await loadDesktopModule()

    await expect(copyImageToClipboard('kition-bundled://assets/example.webp')).resolves.toBe(true)
    expect(copyImage).toHaveBeenNthCalledWith(1, {
      url: 'kition-bundled://assets/example.webp',
    })
    expect(copyImage).toHaveBeenNthCalledWith(2, {
      url: expect.stringMatching(/^data:image\/png;base64,/),
    })
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(closeBitmap).toHaveBeenCalledTimes(1)
  })

  it('proxies workspace document helpers through the desktop bridge when available', async () => {
    const listResponse = {
      root_path: '/tmp/Kition/workspace',
      items: [
        {
          type: 'file',
          path: 'Home.md',
          name: 'Home.md',
        },
      ],
    }
    const document = {
      path: 'Home.md',
      name: 'Home.md',
      content: '# Home',
      updated_at: '2026-05-07T00:00:00.000Z',
      size: 4,
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      ListWorkspaceDocuments: vi.fn().mockResolvedValue(listResponse),
      ReadWorkspaceDocument: vi.fn().mockResolvedValue(document),
      WriteWorkspaceDocument: vi.fn().mockResolvedValue({ ...document, content: '# Updated' }),
      CreateWorkspaceDocument: vi.fn().mockResolvedValue(document),
      MoveWorkspaceDocument: vi.fn().mockResolvedValue({ ...document, path: 'knowledge-base/Home.md' }),
      DeleteWorkspaceDocument: vi.fn().mockResolvedValue(listResponse),
      OpenWorkspaceFile: vi.fn().mockResolvedValue(''),
      SaveWorkspaceAsset: vi.fn().mockResolvedValue({
        path: 'assets/image.png',
        url: 'kition-workspace://assets/image.png',
        mime_type: 'image/png',
      }),
      RevealWorkspaceFolder: vi.fn().mockResolvedValue(''),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve({
        type: 'image/png',
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      }),
    }))

    const desktopModule = await loadDesktopModule()

    await expect(desktopModule.listWorkspaceDocuments()).resolves.toEqual(listResponse)
    await expect(desktopModule.readWorkspaceDocument('Home.md')).resolves.toEqual(document)
    await expect(desktopModule.writeWorkspaceDocument('Home.md', '# Updated')).resolves.toMatchObject({ content: '# Updated' })
    await expect(desktopModule.createWorkspaceDocument({ title: 'New draft', folder: 'knowledge-base' })).resolves.toEqual(document)
    await expect(desktopModule.moveWorkspaceDocument({ path: 'Home.md', target_folder: 'knowledge-base' })).resolves.toMatchObject({ path: 'knowledge-base/Home.md' })
    await expect(desktopModule.moveWorkspaceDocument({ path: 'Home.md', target_name: 'main.md' })).resolves.toMatchObject({ path: 'knowledge-base/Home.md' })
    await expect(desktopModule.deleteWorkspaceDocument('Home.md')).resolves.toEqual(listResponse)
    await expect(desktopModule.openWorkspaceFile('Agent/report.docx')).resolves.toBe('')
    await expect(
      desktopModule.saveWorkspaceAssetFromBlobURL({
        blobURL: 'blob:http://127.0.0.1:3000/image-1',
        documentPath: 'Home.md',
      }),
    ).resolves.toMatchObject({
      url: 'kition-workspace://assets/image.png',
    })
    await expect(desktopModule.revealWorkspaceFolder()).resolves.toBe('')
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.ReadWorkspaceDocument).toHaveBeenCalledWith({ path: 'Home.md' })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.WriteWorkspaceDocument).toHaveBeenCalledWith({ path: 'Home.md', content: '# Updated' })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.MoveWorkspaceDocument).toHaveBeenCalledWith({ path: 'Home.md', target_name: 'main.md', target_folder: '' })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.DeleteWorkspaceDocument).toHaveBeenCalledWith({ path: 'Home.md' })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.OpenWorkspaceFile).toHaveBeenCalledWith({ path: 'Agent/report.docx' })
    expect((window as typeof window & { kitionDesktop?: any }).kitionDesktop.SaveWorkspaceAsset).toHaveBeenCalledWith(expect.objectContaining({
      document_path: 'Home.md',
      mime_type: 'image/png',
    }))
  })

  it('uses a browser local workspace fallback outside desktop runtime', async () => {
    const desktopModule = await loadDesktopModule()

    const initialList = await desktopModule.listWorkspaceDocuments()
    expect(initialList.items.length).toBeGreaterThan(0)
    expect(initialList.items.every((item) => item.type === 'file')).toBe(true)
    expect(initialList.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      'complex-document-template.md',
      'inbox.md',
      'index.md',
    ]))

    const untitled = await desktopModule.createWorkspaceDocument()
    expect(untitled.path).toBe('Untitled note.md')

    const created = await desktopModule.createWorkspaceDocument({
      title: 'test-knowledge-page',
      folder: 'knowledge-base',
      platform: 'knowledge-page',
    })
    expect(created.path).toBe('knowledge-base/test-knowledge-page.md')

    await desktopModule.writeWorkspaceDocument(created.path, '# Updated content')
    await expect(desktopModule.readWorkspaceDocument(created.path)).resolves.toMatchObject({
      content: '# Updated content',
    })

    const child = await desktopModule.createWorkspaceDocument({
      title: 'child-page',
      folder: 'knowledge-base/test-knowledge-page',
      platform: 'knowledge-page',
    })
    expect(child.path).toBe('knowledge-base/test-knowledge-page/child-page.md')

    const moved = await desktopModule.moveWorkspaceDocument({
      path: created.path,
      target_folder: 'idea-notes',
    })
    expect(moved.path).toBe('idea-notes/test-knowledge-page.md')
    await expect(desktopModule.readWorkspaceDocument('idea-notes/test-knowledge-page/child-page.md')).resolves.toMatchObject({
      content: '',
    })

    const renamed = await desktopModule.moveWorkspaceDocument({
      path: moved.path,
      target_name: 'knowledge-home.md',
    })
    expect(renamed.path).toBe('idea-notes/knowledge-home.md')
    await expect(desktopModule.readWorkspaceDocument('idea-notes/knowledge-home/child-page.md')).resolves.toMatchObject({
      content: '',
    })

    await desktopModule.deleteWorkspaceDocument(renamed.path)
    await expect(desktopModule.readWorkspaceDocument(renamed.path)).rejects.toThrow('document not found')
    await expect(desktopModule.readWorkspaceDocument('idea-notes/knowledge-home/child-page.md')).rejects.toThrow('document not found')
  })

  it('migrates legacy browser workspace seeds away from default folders', async () => {
    const homeFile = String.fromCodePoint(0x9996, 0x9875, 0x2e, 0x6d, 0x64)
    const knowledgeDirectory = String.fromCodePoint(0x77e5, 0x8bc6, 0x5e93)
    const knowledgeFile = String.fromCodePoint(0x590d, 0x6742, 0x6587, 0x6863, 0x6a21, 0x677f, 0x2e, 0x6d, 0x64)
    const ideasDirectory = String.fromCodePoint(0x7075, 0x611f, 0x7b14, 0x8bb0)
    const inboxFile = String.fromCodePoint(0x6536, 0x4ef6, 0x7bb1, 0x2e, 0x6d, 0x64)
    window.localStorage.setItem('kition.workspace.documents.v1', JSON.stringify({
      [homeFile]: {
        updated_at: '2026-05-07T00:00:00.000Z',
        content: '# Home',
      },
      [`${knowledgeDirectory}/${knowledgeFile}`]: {
        updated_at: '2026-05-07T00:00:00.000Z',
        content: '# Template',
      },
      [`${ideasDirectory}/${inboxFile}`]: {
        updated_at: '2026-05-07T00:00:00.000Z',
        content: '# Inbox',
      },
    }))
    window.localStorage.setItem('kition.workspace.folders.v1', JSON.stringify([knowledgeDirectory, ideasDirectory]))

    const desktopModule = await loadDesktopModule()
    const workspace = await desktopModule.listWorkspaceDocuments()

    expect(workspace.items.every((item) => item.type === 'file')).toBe(true)
    expect(workspace.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      knowledgeFile,
      inboxFile,
      homeFile,
    ]))
    expect(window.localStorage.getItem('kition.workspace.folders.v1')).toBe('[]')
  })

  it('returns empty browser site results without a desktop bridge', async () => {
    const desktopModule = await loadDesktopModule()

    await expect(desktopModule.listBrowserSites()).resolves.toEqual({ sites: [] })
    await expect(
      desktopModule.forgetBrowserSite({ host: 'example.com' }),
    ).resolves.toEqual({ sites: [] })
    await expect(desktopModule.refreshBrowserSiteLoginStatus()).resolves.toEqual({ sites: [] })
  })

  it('falls back to a safe browser status for navigation commands without a desktop bridge', async () => {
    const desktopModule = await loadDesktopModule()

    for (const command of [
      desktopModule.browserSessionGoBack,
      desktopModule.browserSessionGoForward,
      desktopModule.browserSessionReload,
      desktopModule.browserSessionStop,
    ]) {
      await expect(command({ provider: 'generic-web' })).resolves.toMatchObject({
        provider: 'generic-web',
        window_open: false,
        can_go_back: false,
        can_go_forward: false,
        is_loading: false,
      })
    }
  })

  it('proxies browser navigation commands and surfaces navigation status fields', async () => {
    const status = {
      provider: 'generic-web',
      supported: true,
      available: true,
      window_open: true,
      logged_in: false,
      editor_ready: false,
      page_url: 'https://example.com/list',
      page_title: 'Example List',
      message: 'ready',
      last_error: '',
      can_go_back: true,
      can_go_forward: false,
      is_loading: true,
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      GoBackBrowserSession: vi.fn().mockResolvedValue(status),
      GoForwardBrowserSession: vi.fn().mockResolvedValue(status),
      ReloadBrowserSession: vi.fn().mockResolvedValue(status),
      StopBrowserSession: vi.fn().mockResolvedValue({ ...status, is_loading: false }),
    }

    const desktopModule = await loadDesktopModule()
    const bridge = (window as typeof window & { kitionDesktop?: any }).kitionDesktop

    await expect(
      desktopModule.browserSessionGoBack({ provider: 'generic-web' }),
    ).resolves.toMatchObject({ can_go_back: true, can_go_forward: false, is_loading: true })
    await expect(
      desktopModule.browserSessionGoForward({ provider: 'generic-web' }),
    ).resolves.toMatchObject({ can_go_back: true, is_loading: true })
    await expect(
      desktopModule.browserSessionReload({ provider: 'generic-web' }),
    ).resolves.toMatchObject({ is_loading: true })
    await expect(
      desktopModule.browserSessionStop({ provider: 'generic-web' }),
    ).resolves.toMatchObject({ is_loading: false })

    expect(bridge.GoBackBrowserSession).toHaveBeenCalledWith({ provider: 'generic-web' })
    expect(bridge.StopBrowserSession).toHaveBeenCalledWith({ provider: 'generic-web' })
  })

  it('normalizes navigation flags onto browser session panel state events', async () => {
    const payload = {
      provider: 'generic-web',
      panel_visible: true,
      panel_width: 480,
      page_title: 'Example',
      page_url: 'https://example.com/',
      can_go_back: true,
      can_go_forward: false,
      is_loading: true,
    }
    const eventsOn = vi.fn((eventName: string, callback: (data: unknown) => void) => {
      if (eventName === 'desktop:browser:session-state-updated') {
        callback(payload)
      }
    })

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      EventsOn: eventsOn,
    }

    const desktopModule = await loadDesktopModule()
    const handler = vi.fn()

    desktopModule.registerBrowserSessionStateHandler('generic-web', handler)

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'generic-web',
        url: 'https://example.com/',
        canGoBack: true,
        canGoForward: false,
        isLoading: true,
      }),
    )
  })

  it('normalizes browser site records through the desktop bridge', async () => {
    const listResponse = {
      sites: [
        {
          host: 'example.com',
          profileId: 'default',
          url: 'https://example.com/feed',
          title: 'Example',
          favicon: 'https://example.com/favicon.ico',
          provider: 'generic-web',
          lastSeenAt: '2026-05-20T10:00:00.000Z',
          visitCount: 3,
          loggedIn: true,
          lastCheckedAt: '2026-05-20T10:05:00.000Z',
        },
        { host: 'partial.com' },
      ],
    }

    ;(window as typeof window & { kitionDesktop?: any }).kitionDesktop = {
      shell: 'electron',
      ListBrowserSites: vi.fn().mockResolvedValue(listResponse),
      ForgetBrowserSite: vi.fn().mockResolvedValue({ sites: [] }),
      RefreshBrowserSiteLoginStatus: vi.fn().mockResolvedValue(listResponse),
    }

    const desktopModule = await loadDesktopModule()

    const result = await desktopModule.listBrowserSites()
    expect(result.sites).toHaveLength(2)
    expect(result.sites[0]).toMatchObject({
      host: 'example.com',
      profileId: 'default',
      visitCount: 3,
      loggedIn: true,
    })
    expect(result.sites[1]).toMatchObject({
      host: 'partial.com',
      profileId: '',
      provider: 'generic-web',
      visitCount: 0,
      loggedIn: false,
    })

    await desktopModule.forgetBrowserSite({ host: 'example.com', profile_id: 'default' })
    expect(
      (window as typeof window & { kitionDesktop?: any }).kitionDesktop.ForgetBrowserSite,
    ).toHaveBeenCalledWith({ host: 'example.com', profile_id: 'default' })

    await desktopModule.refreshBrowserSiteLoginStatus({ host: 'example.com' })
    expect(
      (window as typeof window & { kitionDesktop?: any }).kitionDesktop
        .RefreshBrowserSiteLoginStatus,
    ).toHaveBeenCalledWith({ host: 'example.com' })
  })
})
