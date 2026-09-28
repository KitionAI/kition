/**
 * The embedded browser: session windows, navigation, page context extraction, remembered sites, and panel state events.
 */
import { type BrowserPageContext, type BrowserPageContextRequest, type BrowserSessionHostLayoutRequest, type BrowserSessionPanelState, type BrowserSessionProvider, type BrowserSessionRequest, type BrowserSessionStatus, type BrowserSite, type BrowserSiteForgetRequest, type BrowserSiteListResponse, type BrowserSiteRefreshRequest, getDesktopBridge } from './bridge'

const DESKTOP_BROWSER_SESSION_EVENT = 'desktop:browser:session-state-updated'
const browserSessionStateHandlers = new Map<
  string,
  Set<(state: BrowserSessionPanelState) => void>
>()
let browserSessionStateBridgeBound = false

function normalizeBrowserSessionStatus(
  payload: Partial<BrowserSessionStatus> | null | undefined,
  provider: BrowserSessionProvider,
): BrowserSessionStatus {
  return {
    provider,
    profile_id: typeof payload?.profile_id === 'string' ? payload.profile_id : undefined,
    supported: Boolean(payload?.supported),
    driver: typeof payload?.driver === 'string' ? payload.driver : undefined,
    available: Boolean(payload?.available),
    window_open: Boolean(payload?.window_open),
    panel_visible:
      typeof payload?.panel_visible === 'boolean' ? payload.panel_visible : undefined,
    panel_width:
      typeof payload?.panel_width === 'number' ? payload.panel_width : undefined,
    logged_in: Boolean(payload?.logged_in),
    editor_ready:
      typeof payload?.editor_ready === 'boolean' ? payload.editor_ready : undefined,
    can_go_back: Boolean(payload?.can_go_back),
    can_go_forward: Boolean(payload?.can_go_forward),
    is_loading: Boolean(payload?.is_loading),
    page_url: String(payload?.page_url || ''),
    page_title: String(payload?.page_title || ''),
    message: String(payload?.message || ''),
    last_error: String(payload?.last_error || ''),
    runtime:
      payload?.runtime && typeof payload.runtime === 'object'
        ? payload.runtime
        : undefined,
  }
}

function normalizeBrowserPageContext(
  payload: Partial<BrowserPageContext> | null | undefined,
  provider: BrowserSessionProvider,
): BrowserPageContext {
  const contextPayload = (payload || {}) as Partial<BrowserPageContext>
  return {
    provider,
    profile_id: typeof contextPayload.profile_id === 'string' ? contextPayload.profile_id : undefined,
    supported_page: Boolean(contextPayload.supported_page),
    logged_in: Boolean(contextPayload.logged_in),
    editor_ready: Boolean(contextPayload.editor_ready),
    title_ready:
      typeof contextPayload.title_ready === 'boolean' ? contextPayload.title_ready : undefined,
    content_ready:
      typeof contextPayload.content_ready === 'boolean'
        ? contextPayload.content_ready
        : undefined,
    longform_entry_available:
      typeof contextPayload.longform_entry_available === 'boolean'
        ? contextPayload.longform_entry_available
        : undefined,
    page_url: String(contextPayload.page_url || ''),
    page_title: String(contextPayload.page_title || ''),
    hostname: typeof contextPayload.hostname === 'string' ? contextPayload.hostname : undefined,
    page_heading:
      typeof contextPayload.page_heading === 'string' ? contextPayload.page_heading : undefined,
    title_text:
      typeof contextPayload.title_text === 'string' ? contextPayload.title_text : undefined,
    content_text_preview:
      typeof contextPayload.content_text_preview === 'string'
        ? contextPayload.content_text_preview
        : undefined,
    visible_text_preview:
      typeof contextPayload.visible_text_preview === 'string'
        ? contextPayload.visible_text_preview
        : undefined,
    main_content_html:
      typeof contextPayload.main_content_html === 'string'
        ? contextPayload.main_content_html
        : undefined,
    html_snapshot:
      typeof contextPayload.html_snapshot === 'string'
        ? contextPayload.html_snapshot
        : undefined,
    content_blocks: Array.isArray(contextPayload.content_blocks)
      ? contextPayload.content_blocks
          .map((item) => ({
            url: typeof item?.url === 'string' ? item.url : undefined,
            title: typeof item?.title === 'string' ? item.title : undefined,
            summary: typeof item?.summary === 'string' ? item.summary : undefined,
            text: typeof item?.text === 'string' ? item.text : undefined,
            html: typeof item?.html === 'string' ? item.html : undefined,
          }))
          .filter((item) => item.url || item.title || item.summary || item.text)
      : undefined,
    page_type: typeof contextPayload.page_type === 'string' ? contextPayload.page_type : undefined,
    links: Array.isArray(contextPayload.links)
      ? contextPayload.links
          .map((item) => ({
            text: String(item?.text || ''),
            href: String(item?.href || ''),
          }))
          .filter((item) => item.text || item.href)
      : undefined,
    extracted_entities: Array.isArray(contextPayload.extracted_entities)
      ? contextPayload.extracted_entities
          .map((item) => ({
            entity_type:
              typeof item?.entity_type === 'string' ? item.entity_type : undefined,
            url: typeof item?.url === 'string' ? item.url : undefined,
            title: typeof item?.title === 'string' ? item.title : undefined,
            author: typeof item?.author === 'string' ? item.author : undefined,
            published_at:
              typeof item?.published_at === 'string' ? item.published_at : undefined,
            summary: typeof item?.summary === 'string' ? item.summary : undefined,
          }))
          .filter((item) => item.url || item.title || item.summary)
      : undefined,
    extracted_at:
      typeof contextPayload.extracted_at === 'string' ? contextPayload.extracted_at : undefined,
  }
}

export async function getBrowserSessionStatus(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus | null> {
  const bridge = getDesktopBridge()
  if (bridge?.BrowserSessionStatus) {
    const status = await bridge.BrowserSessionStatus(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  return null
}

export async function ensureBrowserSessionWindow(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.EnsureBrowserSessionWindow) {
    const status = await bridge.EnsureBrowserSessionWindow(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  throw new Error(`desktop browser session is unavailable for provider ${request.provider}`)
}

export async function openBrowserSessionHome(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.OpenBrowserSessionHome) {
    const status = await bridge.OpenBrowserSessionHome(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  throw new Error(`desktop browser session home is unavailable for provider ${request.provider}`)
}

export async function hideBrowserSessionPanel(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.HideBrowserSessionPanel) {
    const status = await bridge.HideBrowserSessionPanel(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  throw new Error(`desktop browser session hide-panel is unavailable for provider ${request.provider}`)
}

export async function browserSessionGoBack(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.GoBackBrowserSession) {
    const status = await bridge.GoBackBrowserSession(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  return normalizeBrowserSessionStatus(null, request.provider)
}

export async function browserSessionGoForward(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.GoForwardBrowserSession) {
    const status = await bridge.GoForwardBrowserSession(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  return normalizeBrowserSessionStatus(null, request.provider)
}

export async function browserSessionReload(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.ReloadBrowserSession) {
    const status = await bridge.ReloadBrowserSession(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  return normalizeBrowserSessionStatus(null, request.provider)
}

export async function browserSessionStop(
  request: BrowserSessionRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.StopBrowserSession) {
    const status = await bridge.StopBrowserSession(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  return normalizeBrowserSessionStatus(null, request.provider)
}

export async function setBrowserSessionHostLayout(
  request: BrowserSessionHostLayoutRequest,
): Promise<BrowserSessionStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.SetBrowserSessionHostLayout) {
    const status = await bridge.SetBrowserSessionHostLayout(request)
    return normalizeBrowserSessionStatus(status, request.provider)
  }
  throw new Error(`desktop browser session host layout is unavailable for provider ${request.provider}`)
}

export async function extractBrowserPageContext(
  request: BrowserPageContextRequest,
): Promise<BrowserPageContext> {
  const bridge = getDesktopBridge()
  if (bridge?.ExtractBrowserPageContext) {
    const context = await bridge.ExtractBrowserPageContext(request)
    return normalizeBrowserPageContext(context, request.provider)
  }
  throw new Error(`desktop browser page extraction is unavailable for provider ${request.provider}`)
}

function normalizeBrowserSite(payload: Partial<BrowserSite> | null | undefined): BrowserSite {
  const record = payload || {}
  return {
    host: String(record.host || ''),
    profileId: String(record.profileId || ''),
    url: String(record.url || ''),
    title: String(record.title || ''),
    favicon: String(record.favicon || ''),
    provider: (record.provider as BrowserSessionProvider) || 'generic-web',
    firstSeenAt: String(record.firstSeenAt || record.lastSeenAt || ''),
    lastSeenAt: String(record.lastSeenAt || ''),
    visitCount: Number(record.visitCount) || 0,
    loggedIn: Boolean(record.loggedIn),
    lastCheckedAt: String(record.lastCheckedAt || ''),
  }
}

function normalizeBrowserSiteList(
  payload: Partial<BrowserSiteListResponse> | null | undefined,
): BrowserSiteListResponse {
  const sites = Array.isArray(payload?.sites) ? payload!.sites : []
  return { sites: sites.map((site) => normalizeBrowserSite(site)) }
}

export async function listBrowserSites(): Promise<BrowserSiteListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ListBrowserSites) {
    return normalizeBrowserSiteList(await bridge.ListBrowserSites())
  }
  return { sites: [] }
}

export async function forgetBrowserSite(
  request: BrowserSiteForgetRequest,
): Promise<BrowserSiteListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ForgetBrowserSite) {
    return normalizeBrowserSiteList(await bridge.ForgetBrowserSite(request))
  }
  return { sites: [] }
}

export async function refreshBrowserSiteLoginStatus(
  request: BrowserSiteRefreshRequest = {},
): Promise<BrowserSiteListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.RefreshBrowserSiteLoginStatus) {
    return normalizeBrowserSiteList(await bridge.RefreshBrowserSiteLoginStatus(request))
  }
  return { sites: [] }
}

function normalizeBrowserSessionPanelState(payload?: Partial<BrowserSessionStatus> | Partial<BrowserSessionPanelState>) {
  const panelPayload = (payload || {}) as Partial<BrowserSessionStatus & BrowserSessionPanelState>
  const title = 'title' in panelPayload ? panelPayload.title : panelPayload.page_title
  const url = 'url' in panelPayload ? panelPayload.url : panelPayload.page_url
  const normalized: Omit<BrowserSessionPanelState, 'provider'> = {
    visible: Boolean('visible' in panelPayload ? panelPayload.visible : panelPayload.panel_visible),
    width: Math.max(0, Number('width' in panelPayload ? panelPayload.width : panelPayload.panel_width) || 0),
    title: String(title || ''),
    url: String(url || ''),
    canGoBack: Boolean('canGoBack' in panelPayload ? panelPayload.canGoBack : panelPayload.can_go_back),
    canGoForward: Boolean(
      'canGoForward' in panelPayload ? panelPayload.canGoForward : panelPayload.can_go_forward,
    ),
    isLoading: Boolean('isLoading' in panelPayload ? panelPayload.isLoading : panelPayload.is_loading),
  }
  if ('windowOpen' in panelPayload || 'window_open' in panelPayload) {
    normalized.windowOpen = Boolean(
      'windowOpen' in panelPayload ? panelPayload.windowOpen : panelPayload.window_open,
    )
  }
  if ('loggedIn' in panelPayload || 'logged_in' in panelPayload) {
    normalized.loggedIn = Boolean(
      'loggedIn' in panelPayload ? panelPayload.loggedIn : panelPayload.logged_in,
    )
  }
  if ('message' in panelPayload && typeof panelPayload.message === 'string' && panelPayload.message.trim()) {
    normalized.message = panelPayload.message.trim()
  }
  if ('lastError' in panelPayload || 'last_error' in panelPayload) {
    const lastError = String(
      'lastError' in panelPayload ? panelPayload.lastError : panelPayload.last_error,
    ).trim()
    if (lastError) {
      normalized.lastError = lastError
    }
  }
  if (
    'runtime' in panelPayload &&
    panelPayload.runtime &&
    typeof panelPayload.runtime === 'object'
  ) {
    normalized.runtime = panelPayload.runtime as Record<string, any>
  }
  return normalized
}

export function getBrowserSessionPanelState(
  provider: BrowserSessionProvider,
  status?: Partial<BrowserSessionStatus> | null,
): BrowserSessionPanelState {
  const panel = normalizeBrowserSessionPanelState(status || undefined)
  return {
    provider,
    ...panel,
  }
}

export function registerBrowserSessionStateHandler(
  provider: BrowserSessionProvider,
  handler: (state: BrowserSessionPanelState) => void,
) {
  const bridge = getDesktopBridge()
  if (!bridge?.EventsOn) {
    return () => {}
  }
  const normalizedProvider = String(provider).trim().toLowerCase()
  const handlers = browserSessionStateHandlers.get(normalizedProvider) || new Set()
  handlers.add(handler)
  browserSessionStateHandlers.set(normalizedProvider, handlers)

  if (!browserSessionStateBridgeBound) {
    bridge.EventsOn(
      DESKTOP_BROWSER_SESSION_EVENT,
      (payload: Partial<BrowserSessionStatus> | Partial<BrowserSessionPanelState>) => {
        const payloadProvider = String(payload?.provider || '').trim().toLowerCase()
        if (!payloadProvider) {
          return
        }
        const listeners = browserSessionStateHandlers.get(payloadProvider)
        if (!listeners?.size) {
          return
        }
        const normalizedState = getBrowserSessionPanelState(payloadProvider, payload)
        listeners.forEach((listener) => {
          listener(normalizedState)
        })
      },
    )
    browserSessionStateBridgeBound = true
  }

  return () => {
    const listeners = browserSessionStateHandlers.get(normalizedProvider)
    if (!listeners) {
      return
    }
    listeners.delete(handler)
    if (!listeners.size) {
      browserSessionStateHandlers.delete(normalizedProvider)
    }
  }
}
