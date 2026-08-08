import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, protocol, session, shell } from 'electron'
import * as chokidar from 'chokidar'
import { CommunityBootstrap } from './bootstrap.mjs'
import { BackendSupervisor } from './backend-supervisor.mjs'
import { BrowserSessionManager } from './browser-session-manager.mjs'
import {
  createBundledAssetResponse,
  KITION_BUNDLED_ASSET_SCHEME,
} from './bundled-assets.mjs'
import {
  DESKTOP_BROWSER_SESSION_EVENT,
  DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT,
  DESKTOP_UPDATES_EVENT,
  IPC_CHANNELS,
} from './channels.mjs'
import { UpdateManager } from './update-manager.mjs'
import { buildApplicationMenu } from './menu.mjs'
import { resolveDesktopEnvironment, getBackendBaseURL } from './runtime-paths.mjs'
import { SecureStore } from './secure-store.mjs'
import { ProxyManager } from './proxy-manager.mjs'
import { WorkspaceRegistry } from './workspace-registry.mjs'
import { createWorkspaceWatcher } from './workspace-watcher.mjs'
import { isTrustedWindowNavigation, normalizeExternalURL } from './external-url.mjs'
import { createBeforeQuitHandler } from './quit-lifecycle.mjs'
import { findKitionDeepLink, KITION_PROTOCOL_SCHEME, normalizeKitionDeepLink } from './deep-link.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const DARK_WINDOW_BACKGROUND = '#1b1e22'
const LIGHT_WINDOW_BACKGROUND = '#ffffff'
const DESKTOP_SETTINGS_STORAGE_KEY = 'kition.desktop.settings.v1'

// Pin app.name so userData/userCache/logs always resolve under `Kition` —
// dev mode would otherwise inherit the lowercase package.json `name` and
// diverge from the packaged build's `productName` on case-sensitive FS.
app.setName('Kition')

const isDesktopTestMode = String(process.env.KITION_DESKTOP_SKIP_API || '').toLowerCase() === 'true'
const hasExplicitUserDataDir = process.argv.some((arg) => arg.startsWith('--user-data-dir='))
if (isDesktopTestMode && !hasExplicitUserDataDir) {
  const testProfileRoot = path.resolve(
    String(process.env.KITION_ELECTRON_TEST_DATA_DIR || '').trim()
      || path.join(String(process.env.HOME || process.cwd()), '.kition-e2e'),
  )
  app.setPath('userData', path.join(testProfileRoot, 'userData'))
  app.setPath('sessionData', path.join(testProfileRoot, 'sessionData'))
}

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-quic')
}

// Never touch macOS Keychain. Chromium's OSCrypt would otherwise persist a
// `Kition Safe Storage` entry whose ACL is bound to the current binary
// signature — every re-signed build then pops "Electron wants to use Kition
// Safe Storage" until the user clicks Always Allow. Mock keychain keeps the
// derived key in-memory; cookie/state files are protected by userData dir
// permissions, matching the local user-data trust model.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: KITION_BUNDLED_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'kition-workspace',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

let mainWindow = null
let desktopEnv = null
let secureStore = null
let proxyManager = null
let bootstrap = null
let backendSupervisor = null
let browserSessions = null
let browserSessionTestMock = null
let workspaceRegistry = null
let workspaceWatcher = null
let updateManager = null
let cachedBetaChannel = false
let cachedAutoCheck = true
let pendingKitionDeepLink = findKitionDeepLink(process.argv)

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function registerKitionProtocolClient() {
  if (process.defaultApp && process.argv[1]) {
    return app.setAsDefaultProtocolClient(
      KITION_PROTOCOL_SCHEME,
      process.execPath,
      [path.resolve(process.argv[1])],
    )
  }
  return app.setAsDefaultProtocolClient(KITION_PROTOCOL_SCHEME)
}

async function focusKitionWindow(rawURL) {
  const deepLink = normalizeKitionDeepLink(rawURL)
  if (!deepLink) return

  pendingKitionDeepLink = deepLink
  if (!app.isReady()) return

  await showKitionWindow()
  pendingKitionDeepLink = ''
}

async function showKitionWindow() {
  const win = await createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = findKitionDeepLink(commandLine)
    if (deepLink) {
      void focusKitionWindow(deepLink)
      return
    }
    void showKitionWindow()
  })
}

app.on('open-url', (event, rawURL) => {
  event.preventDefault()
  void focusKitionWindow(rawURL)
})

function buildBrowserSessionTestMockStatus(request = {}, overrides = {}) {
  if (!browserSessionTestMock || typeof browserSessionTestMock !== 'object') {
    return null
  }
  const baseStatus =
    browserSessionTestMock.status &&
    typeof browserSessionTestMock.status === 'object'
      ? browserSessionTestMock.status
      : {}
  const provider = String(
    request.provider || baseStatus.provider || 'generic-web',
  ).trim() || 'generic-web'
  const host = String(request.host || baseStatus.host || '').trim()
  const nextStatus = {
    provider,
    supported: true,
    available: true,
    window_open: true,
    logged_in: true,
    editor_ready: false,
    page_url: String(baseStatus.page_url || ''),
    page_title: String(baseStatus.page_title || ''),
    message: String(baseStatus.message || 'ready'),
    last_error: '',
    panel_visible: Boolean(baseStatus.panel_visible),
    panel_width: Number(baseStatus.panel_width || 0),
    runtime:
      baseStatus.runtime && typeof baseStatus.runtime === 'object'
        ? { ...baseStatus.runtime }
        : {},
    ...baseStatus,
    ...overrides,
  }
  if (host) {
    nextStatus.host = host
  }
  if (request.url) {
    nextStatus.page_url = String(request.url)
  }
  if (request.page_url) {
    nextStatus.page_url = String(request.page_url)
  }
  browserSessionTestMock = {
    ...browserSessionTestMock,
    status: nextStatus,
  }
  return nextStatus
}

function emitBrowserSessionTestMockStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(DESKTOP_BROWSER_SESSION_EVENT, status)
}

function syncBrowserSessionLayout() {
  browserSessions?.layoutPanels?.()
}

async function handleBrowserSessionStatus(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request)
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.status(request)
}

async function handleEnsureBrowserSessionWindow(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request, {
    message: `Opened ${String(request.host || request.url || 'browser page')}`,
    panel_visible: true,
    panel_width: 420,
  })
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.ensureWindow(request)
}

async function handleOpenBrowserSessionHome(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request, {
    panel_visible: true,
    panel_width: 420,
  })
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.openHome(request)
}

async function handleHideBrowserSessionPanel(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request, {
    panel_visible: false,
    panel_width: 0,
  })
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.hidePanel(request)
}

async function handleGoBackBrowserSession(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request)
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.goBack(request)
}

async function handleGoForwardBrowserSession(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request)
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.goForward(request)
}

async function handleReloadBrowserSession(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request)
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.reload(request)
}

async function handleStopBrowserSession(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request)
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.stop(request)
}

async function handleSetBrowserSessionHostLayout(request = {}) {
  const mockedStatus = buildBrowserSessionTestMockStatus(request, {
    panel_visible: true,
    panel_width: Number(request.rightInset || 0) > 0 ? 420 : 0,
  })
  if (mockedStatus) {
    emitBrowserSessionTestMockStatus(mockedStatus)
    return mockedStatus
  }
  return browserSessions.setHostLayout(request)
}

async function handleExtractBrowserPageContext(request = {}) {
  if (browserSessionTestMock && typeof browserSessionTestMock === 'object') {
    const status = buildBrowserSessionTestMockStatus(request) || {}
    const baseContext =
      browserSessionTestMock.pageContext &&
      typeof browserSessionTestMock.pageContext === 'object'
        ? browserSessionTestMock.pageContext
        : {}
    const entities = Array.isArray(baseContext.extracted_entities)
      ? baseContext.extracted_entities
      : []
    const maxLinks = Math.max(0, Number(request.max_links || entities.length) || entities.length)
    return {
      provider: String(request.provider || status.provider || 'generic-web'),
      supported_page: true,
      logged_in: true,
      editor_ready: false,
      page_url: String(status.page_url || baseContext.page_url || ''),
      page_title: String(status.page_title || baseContext.page_title || ''),
      hostname: String(baseContext.hostname || request.host || ''),
      page_heading: String(baseContext.page_heading || ''),
      page_type: String(baseContext.page_type || 'list'),
      content_text_preview: String(baseContext.content_text_preview || ''),
      visible_text_preview: String(baseContext.visible_text_preview || ''),
      extracted_at: String(baseContext.extracted_at || new Date().toISOString()),
      ...baseContext,
      extracted_entities: entities.slice(0, maxLinks),
    }
  }
  return browserSessions.extractPageContext(request)
}

async function handleSetBrowserSessionTestMock(_event, request = null) {
  if (!request || typeof request !== 'object') {
    browserSessionTestMock = null
    return { enabled: false }
  }
  browserSessionTestMock = {
    status:
      request.status && typeof request.status === 'object'
        ? { ...request.status }
        : {},
    pageContext:
      request.pageContext && typeof request.pageContext === 'object'
        ? {
            ...request.pageContext,
            extracted_entities: Array.isArray(request.pageContext.extracted_entities)
              ? [...request.pageContext.extracted_entities]
              : [],
          }
        : {},
  }
  return { enabled: true }
}

async function handleListBrowserSites() {
  return browserSessions.listSites()
}

async function handleForgetBrowserSite(request = {}) {
  return browserSessions.forgetSite(request)
}

async function handleRefreshBrowserSiteLoginStatus(request = {}) {
  return browserSessions.refreshLoginStatus(request)
}

function getRendererURL() {
  if (process.env.KITION_ELECTRON_DEV_SERVER_URL) {
    return process.env.KITION_ELECTRON_DEV_SERVER_URL
  }
  return new URL('../dist/index.html', import.meta.url).toString()
}

function getInitialWindowURL() {
  if (isDesktopTestMode) {
    return 'about:blank'
  }
  return getRendererURL()
}

async function getInitialWindowBackgroundColor() {
  let themeMode = 'dark'
  try {
    const raw = await secureStore?.get(DESKTOP_SETTINGS_STORAGE_KEY)
    const persistedTheme = raw ? JSON.parse(raw)?.general?.theme : ''
    if (persistedTheme === 'light' || persistedTheme === 'dark' || persistedTheme === 'auto') {
      themeMode = persistedTheme
    }
  } catch {
    // A missing or malformed setting uses the product's dark default.
  }

  if (themeMode === 'light') {
    return LIGHT_WINDOW_BACKGROUND
  }
  if (themeMode === 'auto' && !nativeTheme.shouldUseDarkColors) {
    return LIGHT_WINDOW_BACKGROUND
  }
  return DARK_WINDOW_BACKGROUND
}

function refreshApplicationMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  Menu.setApplicationMenu(
    buildApplicationMenu(mainWindow, {
      windowAction: (action) => handleWindowAction(action),
      openRuntimePath: (kind) => handleOpenRuntimePath(kind),
      showAboutDialog: () =>
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Kition Desktop',
          message: `Kition ${app.getVersion()}`,
          detail:
            'Documents, data tables, AI agents, and workflows in one workspace.\n\nCopyright © 2026 Heartie Technology Limited. All rights reserved.',
        }),
    }),
  )
}

function toggleDevTools(win = mainWindow) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    return
  }
  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools()
    return
  }
  win.webContents.openDevTools({ mode: 'detach' })
}

function registerMainWindowShortcuts(win) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
    return
  }
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') {
      return
    }
    event.preventDefault()
    toggleDevTools(win)
  })
}

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  const backgroundColor = await getInitialWindowBackgroundColor()
  const initialWindowURL = getInitialWindowURL()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    backgroundColor,
    title: 'Kition Desktop',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      additionalArguments: [`--kition-backend-origin=${desktopEnv?.backend_url || ''}`],
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(normalizeExternalURL(url))
    } catch {
      // Untrusted protocols stay inside the denied window-open request.
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedWindowNavigation(url, initialWindowURL)) return
    event.preventDefault()
    try {
      void shell.openExternal(normalizeExternalURL(url))
    } catch {
      // Local files and custom protocols are blocked instead of delegated.
    }
  })
  registerMainWindowShortcuts(mainWindow)
  refreshApplicationMenu()

  await mainWindow.loadURL(initialWindowURL)
  if (!mainWindow.isDestroyed()) {
    mainWindow.show()
  }

  mainWindow.on('resize', syncBrowserSessionLayout)
  mainWindow.on('enter-full-screen', syncBrowserSessionLayout)
  mainWindow.on('leave-full-screen', syncBrowserSessionLayout)
  mainWindow.on('closed', () => {
    browserSessions?.hidePanels?.()
    mainWindow = null
  })

  return mainWindow
}

async function handleWindowAction(action) {
  const win = await createMainWindow()
  switch (action) {
    case 'minimise':
      win.minimize()
      break
    case 'toggle-maximise':
      win.isMaximized() ? win.unmaximize() : win.maximize()
      break
    case 'fullscreen':
      win.setFullScreen(!win.isFullScreen())
      break
    case 'reload':
      win.webContents.reload()
      break
    case 'toggle-devtools':
      toggleDevTools(win)
      break
    case 'center':
      win.center()
      break
    case 'quit':
      app.quit()
      break
    default:
      throw new Error(`unsupported window action: ${action}`)
  }
}

async function handleOpenRuntimePath(kind) {
  const lookup = {
    data: desktopEnv.data_dir,
    cache: desktopEnv.cache_dir,
    logs: desktopEnv.logs_dir,
    exports: desktopEnv.exports_dir,
  }
  const target = lookup[kind]
  if (!target) {
    return
  }
  await shell.openPath(target)
}

async function handleSaveTextFile(_event, request) {
  const win = await createMainWindow()
  const result = await dialog.showSaveDialog(win, {
    title: request.dialogTitle,
    defaultPath: path.join(desktopEnv.exports_dir, request.defaultFilename),
  })
  if (result.canceled || !result.filePath) {
    return ''
  }
  await fs.writeFile(result.filePath, request.content, 'utf8')
  return result.filePath
}

async function handleSaveBinaryFile(_event, request) {
  const win = await createMainWindow()
  const result = await dialog.showSaveDialog(win, {
    title: request.dialog_title,
    defaultPath: path.join(desktopEnv.exports_dir, request.default_filename),
  })
  if (result.canceled || !result.filePath) {
    return ''
  }
  await fs.writeFile(result.filePath, Buffer.from(request.base64_content, 'base64'))
  return result.filePath
}

function getBackendPublicBaseURL() {
  return getBackendBaseURL().replace(/\/api\/?$/i, '')
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function resolveExportImageURL(src) {
  const raw = String(src || '').trim()
  if (!raw || /^(data:|blob:)/i.test(raw)) {
    return ''
  }
  if (/^(kition-workspace:|https?:\/\/)/i.test(raw)) {
    return raw
  }
  if (raw.startsWith('/')) {
    return new URL(raw, getBackendPublicBaseURL()).toString()
  }
  return ''
}

function decodeURIPath(pathname) {
  return String(pathname || '')
    .split('/')
    .map((part) => {
      let decoded = part
      for (let index = 0; index < 3; index += 1) {
        try {
          const next = decodeURIComponent(decoded)
          if (next === decoded) {
            break
          }
          decoded = next
        } catch {
          break
        }
      }
      return decoded
    })
    .join('/')
}

function stripURLSuffix(value) {
  return String(value || '').replace(/[?#].*$/, '')
}

function unwrapMarkdownDestination(value) {
  const raw = String(value || '').trim()
  return raw.startsWith('<') && raw.endsWith('>')
    ? raw.slice(1, -1).trim()
    : raw
}

function parentWorkspacePath(documentPath) {
  const normalized = String(documentPath || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function isImagePath(value) {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(stripURLSuffix(value))
}

function isWorkspaceRootImagePath(value) {
  const [root = ''] = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  return root.toLowerCase() === 'agent' || root.toLowerCase() === '.kition'
}

function imageMimeTypeFromPath(filePath) {
  switch (path.extname(stripURLSuffix(filePath)).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.avif':
      return 'image/avif'
    case '.png':
    default:
      return 'image/png'
  }
}

function workspaceRelativePathFromPublicURL(raw) {
  const value = String(raw || '').trim()
  if (!value) {
    return ''
  }

  try {
    const parsedURL = new URL(value, getBackendPublicBaseURL())
    const backendURL = new URL(getBackendPublicBaseURL())
    const isBackendURL = parsedURL.origin === backendURL.origin
    const isRootRelativeURL = value.startsWith('/')
    if ((isBackendURL || isRootRelativeURL) && parsedURL.pathname.startsWith('/workspace-files/')) {
      return decodeURIPath(parsedURL.pathname.slice('/workspace-files/'.length))
    }
  } catch {
    return ''
  }

  return ''
}

function exportImageFilePath(src, documentPath = '') {
  const raw = unwrapMarkdownDestination(src)
  if (!raw || (/^(data:|blob:|https?:\/\/)/i.test(raw) && !workspaceRelativePathFromPublicURL(raw))) {
    return ''
  }

  try {
    if (/^kition-workspace:/i.test(raw)) {
      return resolveWorkspaceProtocolPath(raw).absolutePath
    }

    if (/^file:/i.test(raw)) {
      const absolutePath = fileURLToPath(stripURLSuffix(raw))
      const resolvedRoot = path.resolve(getWorkspaceRoot())
      const resolvedTarget = path.resolve(absolutePath)
      return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) ? resolvedTarget : ''
    }

    const publicWorkspacePath = workspaceRelativePathFromPublicURL(raw)
    if (publicWorkspacePath) {
      return resolveWorkspacePath(publicWorkspacePath).absolutePath
    }

    if (isImagePath(raw)) {
      const relativePath = stripURLSuffix(raw).replace(/^\/+/, '')
      const basePath = isWorkspaceRootImagePath(relativePath)
        ? ''
        : parentWorkspacePath(documentPath)
      return resolveWorkspacePath(basePath ? `${basePath}/${relativePath}` : relativePath).absolutePath
    }
  } catch (error) {
    console.warn('failed to resolve export image file:', raw, error)
  }

  return ''
}

async function imageFileToDataURL(filePath) {
  if (!filePath) {
    return ''
  }
  try {
    const buffer = await fs.readFile(filePath)
    return `data:${imageMimeTypeFromPath(filePath)};base64,${buffer.toString('base64')}`
  } catch (error) {
    console.warn('failed to inline export image file:', filePath, error)
    return ''
  }
}

async function imageSourceToDataURL(src, documentPath = '') {
  const localDataURL = await imageFileToDataURL(exportImageFilePath(src, documentPath))
  if (localDataURL) {
    return localDataURL
  }

  const url = resolveExportImageURL(src)
  if (!url) {
    return ''
  }
  try {
    const response = await net.fetch(url)
    if (!response.ok) {
      console.warn('failed to inline export image:', url, response.status)
      return ''
    }
    const contentType = response.headers.get('content-type') || 'image/png'
    if (!/^image\//i.test(contentType)) {
      return ''
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    return `data:${contentType};base64,${buffer.toString('base64')}`
  } catch (error) {
    console.warn('failed to inline export image:', url, error)
    return ''
  }
}

async function inlineExportImages(html, documentPath = '') {
  const sourceByRawValue = new Map()
  const imageSourcePattern = /<img\b[^>]*?\bsrc=(["'])(.*?)\1[^>]*>/gi
  for (const match of String(html || '').matchAll(imageSourcePattern)) {
    const rawValue = match[2]
    if (!sourceByRawValue.has(rawValue)) {
      sourceByRawValue.set(rawValue, null)
    }
  }
  if (!sourceByRawValue.size) {
    return html
  }

  for (const rawValue of sourceByRawValue.keys()) {
    sourceByRawValue.set(rawValue, await imageSourceToDataURL(decodeHtmlAttribute(rawValue), documentPath))
  }

  return String(html || '').replace(imageSourcePattern, (tag, quote, rawValue) => {
    const dataURL = sourceByRawValue.get(rawValue)
    if (!dataURL) {
      return tag
    }
    return tag.replace(`${quote}${rawValue}${quote}`, `${quote}${escapeHtmlAttribute(dataURL)}${quote}`)
  })
}

function unresolvedClipboardImageSources(html) {
  const sources = []
  const imageSourcePattern = /<img\b[^>]*?\bsrc=(["'])(.*?)\1[^>]*>/gi
  for (const match of String(html || '').matchAll(imageSourcePattern)) {
    const source = decodeHtmlAttribute(match[2])
    if (source && !/^data:image\//i.test(source)) {
      sources.push(source)
    }
  }
  return sources
}

async function handleCopyDocumentHtml(_event, request) {
  const html = await inlineExportImages(
    String(request?.html || ''),
    String(request?.document_path || ''),
  )
  const unresolvedSources = unresolvedClipboardImageSources(html)
  if (unresolvedSources.length) {
    throw new Error(`failed to embed ${unresolvedSources.length} clipboard image(s)`)
  }
  clipboard.write({
    html,
    text: String(request?.text || ''),
  })
  return true
}

async function handleCopyImage(_event, request) {
  const source = String(request?.url || '').trim()
  if (!source) {
    throw new Error('image URL is required')
  }

  let image
  if (/^data:image\//i.test(source)) {
    image = nativeImage.createFromDataURL(source)
  } else {
    const response = await net.fetch(source)
    if (!response.ok) {
      throw new Error(`image download failed: ${response.status}`)
    }
    image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  }
  if (image.isEmpty()) {
    throw new Error('image data is empty')
  }
  clipboard.writeImage(image)
  return true
}

async function handleSavePdfFile(_event, request) {
  const win = await createMainWindow()
  const defaultFilename = String(request?.default_filename || 'document.pdf').toLowerCase().endsWith('.pdf')
    ? String(request?.default_filename || 'document.pdf')
    : `${String(request?.default_filename || 'document')}.pdf`
  const result = await dialog.showSaveDialog(win, {
    title: request?.dialog_title || 'Export PDF',
    defaultPath: path.join(desktopEnv.exports_dir, defaultFilename),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) {
    return ''
  }

  const printWindow = new BrowserWindow({
    width: 900,
    height: 1200,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  try {
    const html = await inlineExportImages(String(request?.html || ''), String(request?.document_path || ''))
    const dataURL = `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`
    await printWindow.loadURL(dataURL)
    await printWindow.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready : true', true)
    await printWindow.webContents.executeJavaScript(`
      (async () => {
        const images = Array.from(document.images || []);
        if (!images.length) return true;
        await Promise.race([
          Promise.all(images.map((image) => {
            image.loading = 'eager';
            if (image.complete) return true;
            return new Promise((resolve) => {
              image.addEventListener('load', () => resolve(true), { once: true });
              image.addEventListener('error', () => resolve(false), { once: true });
            });
          })),
          new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
        ]);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })();
    `, true)
    const pageSize = String(request?.page_format || 'a4').toUpperCase()
    const marginsType = request?.margins_type === 1 || request?.margins_type === 2 ? request.margins_type : 0
    const printOpts = {
      pageSize,
      printBackground: true,
      preferCSSPageSize: false,
      landscape: Boolean(request?.landscape),
      marginsType,
    }
    const scalePercent = Number(request?.scale_factor)
    if (Number.isFinite(scalePercent) && scalePercent > 0) {
      printOpts.scale = Math.min(2, Math.max(0.1, scalePercent / 100))
    }
    const pdfBuffer = await printWindow.webContents.printToPDF(printOpts)
    await fs.writeFile(result.filePath, pdfBuffer)
    void shell.openPath(result.filePath)
    return result.filePath
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close()
    }
  }
}

function getWorkspaceRoot() {
  return desktopEnv?.workspace_dir || path.join(desktopEnv.data_dir, 'workspace')
}

function hasActiveVault() {
  return Boolean(workspaceRegistry?.activeVaultPath)
}

function normalizeWorkspacePath(rawPath, { allowRoot = false } = {}) {
  const value = String(rawPath || '').replace(/\\/g, '/').trim()

  if (!value) {
    if (allowRoot) {
      return ''
    }
    throw new Error('document path is required')
  }

  if (value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('invalid document path')
  }

  const normalized = path.posix.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    if (allowRoot && normalized === '.') {
      return ''
    }
    throw new Error('invalid document path')
  }

  return normalized
}

function resolveWorkspacePath(rawPath, options) {
  const root = getWorkspaceRoot()
  const relativePath = normalizeWorkspacePath(rawPath, options)
  const target = relativePath ? path.join(root, ...relativePath.split('/')) : root
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('document path escapes workspace')
  }

  return {
    relativePath,
    absolutePath: resolvedTarget,
  }
}

function sanitizeWorkspaceFilename(title) {
  const fallback = 'Untitled document'
  const baseName = String(title || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || fallback

  return baseName.toLowerCase().endsWith('.md') ? baseName : `${baseName}.md`
}

function inferWorkspaceDocumentFormat(relativePath) {
  const extension = path.extname(String(relativePath || '')).toLowerCase()
  switch (extension) {
    case '.kitable':
      return 'data'
    case '.kinote':
      return 'plate'
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.docx':
      return 'docx'
    case '.xlsx':
    case '.xls':
      return 'xlsx'
    case '.pptx':
    case '.ppt':
      return 'pptx'
    case '.pdf':
      return 'pdf'
    case '.csv':
    case '.tsv':
      return 'csv'
    case '.json':
      return 'json'
    case '.txt':
      return 'text'
    case '.html':
    case '.htm':
      return 'html'
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
    case '.svg':
      return 'image'
    case '.mp4':
    case '.mov':
    case '.webm':
      return 'video'
    case '.mp3':
    case '.wav':
    case '.m4a':
      return 'audio'
    default:
      return 'binary'
  }
}

function isEditableWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kinote|kitable)$/i.test(String(relativePath || ''))
}

function isTextWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kinote|txt|csv|tsv|json|html|htm)$/i.test(String(relativePath || ''))
}

function isSupportedWorkspaceDocument(relativePath) {
  return /\.(md|markdown|kinote|kitable|txt|csv|tsv|json|html|htm|pdf|docx|xlsx|xls|pptx|ppt|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a)$/i.test(String(relativePath || ''))
}

function sanitizeWorkspaceDocumentFilename(title, format = 'markdown') {
  const extension = format === 'plate' ? '.kinote' : format === 'data' ? '.kitable' : '.md'
  const fallback = 'Untitled document'
  const baseName = String(title || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || fallback

  return /\.(md|kinote|kitable)$/i.test(baseName) ? baseName.replace(/\.(md|kinote|kitable)$/i, extension) : `${baseName}${extension}`
}

async function pickUniqueWorkspaceDocumentTarget(folderAbsolutePath, requestedFilename) {
  const extension = path.extname(requestedFilename) || '.md'
  const stem = path.basename(requestedFilename, extension)
  let finalFilename = requestedFilename
  let index = 2

  while (true) {
    const finalStem = path.basename(finalFilename, extension)
    try {
      await fs.access(path.join(folderAbsolutePath, finalFilename))
      finalFilename = `${stem} ${index}${extension}`
      index += 1
      continue
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }

    try {
      await fs.access(path.join(folderAbsolutePath, finalStem))
      finalFilename = `${stem} ${index}${extension}`
      index += 1
      continue
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return finalFilename
      }
      throw error
    }
  }
}

async function pickUniqueWorkspaceFolderTarget(parentAbsolutePath, requestedName) {
  const baseName = String(requestedName || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^\.+/, '').slice(0, 80).trim() || 'Untitled'
  let finalName = baseName
  let index = 2

  while (true) {
    try {
      await fs.access(path.join(parentAbsolutePath, finalName))
      finalName = `${baseName} ${index}`
      index += 1
      continue
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return finalName
      }
      throw error
    }
  }
}

function sanitizeWorkspaceAssetName(title, fallbackExtension) {
  const fallback = `image${fallbackExtension}`
  const baseName = String(title || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || fallback
  return baseName.includes('.') ? baseName : `${baseName}${fallbackExtension}`
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase()
  switch (normalized) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    case 'image/png':
    default:
      return '.png'
  }
}

function fileURLFromPath(filePath) {
  return pathToFileURL(filePath).toString()
}

function workspaceURLFromPath(relativePath) {
  return `kition-workspace://${relativePath.split('/').map((part) => encodeURIComponent(part)).join('/')}`
}

async function moveFileIfPresent(sourcePath, targetPath) {
  try {
    await fs.access(sourcePath)
  } catch {
    return
  }

  try {
    await fs.access(targetPath)
    return
  } catch {
    // Continue with the migration when the target does not exist yet.
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.rename(sourcePath, targetPath)
}

async function removeDirectoryIfEmpty(directoryPath) {
  try {
    await fs.rmdir(directoryPath)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
      throw error
    }
  }
}

const legacyKnowledgeDirectory = String.fromCodePoint(0x77e5, 0x8bc6, 0x5e93)
const legacyKnowledgeFile = String.fromCodePoint(0x590d, 0x6742, 0x6587, 0x6863, 0x6a21, 0x677f, 0x2e, 0x6d, 0x64)
const legacyIdeasDirectory = String.fromCodePoint(0x7075, 0x611f, 0x7b14, 0x8bb0)
const legacyInboxFile = String.fromCodePoint(0x6536, 0x4ef6, 0x7bb1, 0x2e, 0x6d, 0x64)
const legacyAssetsDirectory = String.fromCodePoint(0x7d20, 0x6750)
const legacyArchiveDirectory = String.fromCodePoint(0x5f52, 0x6863)

async function ensureWorkspaceInitialized() {
  const root = getWorkspaceRoot()
  await fs.mkdir(root, { recursive: true })

  await moveFileIfPresent(
    path.join(root, legacyKnowledgeDirectory, legacyKnowledgeFile),
    path.join(root, legacyKnowledgeFile),
  )
  await moveFileIfPresent(
    path.join(root, legacyIdeasDirectory, legacyInboxFile),
    path.join(root, legacyInboxFile),
  )

  for (const legacyDirectory of [legacyKnowledgeDirectory, legacyIdeasDirectory, legacyAssetsDirectory, legacyArchiveDirectory]) {
    await removeDirectoryIfEmpty(path.join(root, legacyDirectory))
  }
}

async function readWorkspaceTree(parentPath = '') {
  const { relativePath, absolutePath } = resolveWorkspacePath(parentPath, { allowRoot: true })
  const entries = await fs.readdir(absolutePath, { withFileTypes: true })
  const items = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue
    }

    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
    const nextAbsolutePath = path.join(absolutePath, entry.name)
    const stats = await fs.stat(nextAbsolutePath)

    if (entry.isDirectory()) {
      items.push({
        type: 'folder',
        path: nextRelativePath,
        name: entry.name,
        updated_at: stats.mtime.toISOString(),
        children: await readWorkspaceTree(nextRelativePath),
      })
      continue
    }

    if (entry.isFile() && isSupportedWorkspaceDocument(entry.name)) {
      items.push({
        type: 'file',
        path: nextRelativePath,
        name: entry.name,
        format: inferWorkspaceDocumentFormat(nextRelativePath),
        size: stats.size,
        updated_at: stats.mtime.toISOString(),
      })
    }
  }

  return items.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'folder' ? -1 : 1
    }
    return left.name.localeCompare(right.name, 'en-US')
  })
}

async function buildWorkspaceDocumentResponse(relativePath, absolutePath) {
  const stats = await fs.stat(absolutePath)
  const textContent = isTextWorkspaceDocument(relativePath)
    ? await fs.readFile(absolutePath, 'utf8')
    : ''
  return {
    path: relativePath,
    name: path.basename(relativePath),
    content: textContent,
    format: inferWorkspaceDocumentFormat(relativePath),
    updated_at: stats.mtime.toISOString(),
    size: stats.size,
    mtime_ms: stats.mtimeMs,
  }
}

async function restartBackendForWorkspaceChange() {
  if (!backendSupervisor) {
    return
  }
  backendSupervisor.env.workspace_dir = desktopEnv.workspace_dir
  try {
    await backendSupervisor.retry()
  } catch (error) {
    console.warn('failed to restart backend after workspace change:', error)
  }
}

async function handleListWorkspaceDocuments() {
  await ensureWorkspaceInitialized()
  return {
    root_path: getWorkspaceRoot(),
    items: await readWorkspaceTree(),
  }
}

async function getWorkspaceDocumentListResponse() {
  await ensureWorkspaceInitialized()
  return {
    root_path: getWorkspaceRoot(),
    items: await readWorkspaceTree(),
  }
}

async function applyActiveVault(vaultPath) {
  const trimmed = String(vaultPath || '').trim()
  if (!trimmed) {
    if (workspaceWatcher) {
      try { await workspaceWatcher.close() } catch {}
      workspaceWatcher = null
    }
    if (workspaceRegistry) {
      await workspaceRegistry.clearActiveVault()
    }
    return
  }

  const stats = await fs.stat(trimmed)
  if (!stats.isDirectory()) {
    throw new Error('workspace path must be a directory')
  }
  // Skip the expensive Go-backend SIGTERM/respawn when the caller re-selects
  // the same workspace (boot rehydration, vault list refresh, identical
  // setActiveVault). Saves multi-second stalls on a no-op switch.
  const previous = String(desktopEnv?.workspace_dir || '').trim()
  const workspaceChanged = previous !== trimmed
  desktopEnv.workspace_dir = trimmed
  if (workspaceRegistry) {
    await workspaceRegistry.setActiveVault(trimmed)
  }
  if (workspaceChanged) {
    await restartBackendForWorkspaceChange()
  }

  // Tear down any existing watcher when vault path changes (or clears).
  if (workspaceWatcher) {
    try { await workspaceWatcher.close() } catch (err) { console.warn('workspace-watcher close failed:', err) }
    workspaceWatcher = null
  }
  if (trimmed) {
    try {
      workspaceWatcher = await createWorkspaceWatcher({
        rootPath: trimmed,
        chokidar,
        onEvent: (payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT, payload)
          }
        },
      })
    } catch (err) {
      console.warn('workspace-watcher failed to start, falling back to probe-only mode:', err)
      workspaceWatcher = null
    }
  }
}

async function handleChooseWorkspaceFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open documents folder',
    properties: ['openDirectory', 'createDirectory'],
  })

  if (result.canceled || !result.filePaths?.[0]) {
    return null
  }

  await applyActiveVault(result.filePaths[0])
  return getWorkspaceDocumentListResponse()
}

async function handleSetWorkspaceFolder(_event, request) {
  const workspacePath = String(request?.path || '').trim()
  if (!workspacePath || workspacePath.includes('\0')) {
    throw new Error('workspace path is required')
  }

  await applyActiveVault(workspacePath)
  return getWorkspaceDocumentListResponse()
}

async function handleChooseDirectory(_event, request) {
  const title = String(request?.title || 'Choose folder')
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths?.[0]) {
    return { canceled: true, path: '' }
  }
  return { canceled: false, path: result.filePaths[0] }
}

async function handleListVaults() {
  if (!workspaceRegistry) {
    return { vaults: [], active_vault_path: '' }
  }
  await workspaceRegistry.load()
  return workspaceRegistry.list()
}

async function handleAddVault(_event, request) {
  if (!workspaceRegistry) {
    throw new Error('workspace registry is unavailable')
  }
  const vault = await workspaceRegistry.addVault(request || {})
  return { vault, registry: workspaceRegistry.list() }
}

async function handleRemoveVault(_event, request) {
  if (!workspaceRegistry) {
    return { vaults: [], active_vault_path: '' }
  }
  const path = String(request?.path || '').trim()
  return workspaceRegistry.removeVault(path)
}

async function handleRenameVault(_event, request) {
  if (!workspaceRegistry) {
    throw new Error('workspace registry is unavailable')
  }
  const vaultPath = String(request?.path || '').trim()
  const name = String(request?.name || '').trim()
  if (!vaultPath) {
    throw new Error('vault path is required')
  }
  const vault = await workspaceRegistry.renameVault(vaultPath, name)
  return { vault, registry: workspaceRegistry.list() }
}

async function handleSetActiveVault(_event, request) {
  const vaultPath = String(request?.path || '').trim()
  if (!vaultPath) {
    throw new Error('vault path is required')
  }
  await applyActiveVault(vaultPath)
  const listResponse = await getWorkspaceDocumentListResponse()
  const registry = workspaceRegistry ? workspaceRegistry.list() : { vaults: [], active_vault_path: vaultPath }
  return { list: listResponse, registry }
}

async function handleReadWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()
  const { relativePath, absolutePath } = resolveWorkspacePath(request?.path)
  if (!isTextWorkspaceDocument(relativePath) && inferWorkspaceDocumentFormat(relativePath) !== 'data') {
    throw new Error('this workspace file is not text-editable')
  }
  return buildWorkspaceDocumentResponse(relativePath, absolutePath)
}

async function handleStatWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()
  try {
    const { absolutePath } = resolveWorkspacePath(request?.path)
    const stats = await fs.stat(absolutePath)
    return { mtime_ms: stats.mtimeMs, size: stats.size }
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

async function handleWriteWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()
  const { relativePath, absolutePath } = resolveWorkspacePath(request?.path)
  if (!isEditableWorkspaceDocument(relativePath)) {
    throw new Error('only markdown and Plate documents can be saved as text')
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  workspaceWatcher?.markSelfWrite?.(absolutePath)
  await fs.writeFile(absolutePath, String(request?.content || ''), 'utf8')
  return buildWorkspaceDocumentResponse(relativePath, absolutePath)
}

async function handleCreateWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()
  const folderPath = normalizeWorkspacePath(request?.folder || '', { allowRoot: true })
  const { absolutePath: folderAbsolutePath } = resolveWorkspacePath(folderPath, { allowRoot: true })
  await fs.mkdir(folderAbsolutePath, { recursive: true })

  const format = request?.format === 'plate' ? 'plate' : request?.format === 'data' ? 'data' : 'markdown'
  const finalFilename = await pickUniqueWorkspaceDocumentTarget(folderAbsolutePath, sanitizeWorkspaceDocumentFilename(request?.title, format))

  const title = path.basename(finalFilename, path.extname(finalFilename))
  const content = format === 'plate'
    ? JSON.stringify({
      version: 1,
      format: 'kition-plate',
      title,
      markdown: '',
      value: [{ type: 'p', children: [{ text: '' }] }],
    }, null, 2)
    : ''

  const relativePath = folderPath ? `${folderPath}/${finalFilename}` : finalFilename
  const absolutePath = path.join(folderAbsolutePath, finalFilename)
  await fs.writeFile(absolutePath, content, 'utf8')
  return buildWorkspaceDocumentResponse(relativePath, absolutePath)
}

async function handleCreateWorkspaceFolder(_event, request) {
  await ensureWorkspaceInitialized()

  const parentFolderPath = normalizeWorkspacePath(request?.parent_folder || '', { allowRoot: true })
  const { absolutePath: parentFolderAbsolutePath } = resolveWorkspacePath(parentFolderPath, { allowRoot: true })
  await fs.mkdir(parentFolderAbsolutePath, { recursive: true })

  const finalFolderName = await pickUniqueWorkspaceFolderTarget(
    parentFolderAbsolutePath,
    String(request?.name || '').trim() || 'Untitled folder',
  )
  const relativePath = parentFolderPath ? `${parentFolderPath}/${finalFolderName}` : finalFolderName
  const absolutePath = path.join(parentFolderAbsolutePath, finalFolderName)
  await fs.mkdir(absolutePath, { recursive: true })

  return {
    root_path: getWorkspaceRoot(),
    items: await readWorkspaceTree(),
    created_path: relativePath,
  }
}

async function handleMoveWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()

  const source = resolveWorkspacePath(request?.path)
  const sourceStat = await fs.stat(source.absolutePath)
  if (!sourceStat.isFile() || !isEditableWorkspaceDocument(source.relativePath)) {
    throw new Error('only editable workspace documents can be moved')
  }

  const sourceParentPath = path.posix.dirname(source.relativePath) === '.' ? '' : path.posix.dirname(source.relativePath)
  const targetFolderPath = request?.target_folder === undefined
    ? sourceParentPath
    : normalizeWorkspacePath(request?.target_folder || '', { allowRoot: true })
  const requestedFilename = String(request?.target_name || '').trim()
  const sourceFilename = path.basename(source.relativePath)
  if (targetFolderPath === sourceParentPath && (!requestedFilename || requestedFilename === sourceFilename)) {
    return buildWorkspaceDocumentResponse(source.relativePath, source.absolutePath)
  }

  const { absolutePath: targetFolderAbsolutePath } = resolveWorkspacePath(targetFolderPath, { allowRoot: true })
  await fs.mkdir(targetFolderAbsolutePath, { recursive: true })

  const finalFilename = await pickUniqueWorkspaceDocumentTarget(
    targetFolderAbsolutePath,
    requestedFilename || sourceFilename,
  )
  const targetRelativePath = targetFolderPath ? `${targetFolderPath}/${finalFilename}` : finalFilename
  const targetAbsolutePath = path.join(targetFolderAbsolutePath, finalFilename)

  const sourceStem = path.basename(source.relativePath, path.extname(source.relativePath))
  const targetStem = path.basename(finalFilename, path.extname(finalFilename))
  const sourceChildFolderRelativePath = sourceParentPath ? `${sourceParentPath}/${sourceStem}` : sourceStem
  const targetChildFolderRelativePath = targetFolderPath ? `${targetFolderPath}/${targetStem}` : targetStem
  const sourceChildFolder = resolveWorkspacePath(sourceChildFolderRelativePath, { allowRoot: true })
  const targetChildFolder = resolveWorkspacePath(targetChildFolderRelativePath, { allowRoot: true })

  await fs.rename(source.absolutePath, targetAbsolutePath)

  if (sourceChildFolder.absolutePath !== targetChildFolder.absolutePath) {
    try {
      const childStat = await fs.stat(sourceChildFolder.absolutePath)
      if (childStat.isDirectory()) {
        await fs.rename(sourceChildFolder.absolutePath, targetChildFolder.absolutePath)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }

  return buildWorkspaceDocumentResponse(targetRelativePath, targetAbsolutePath)
}

async function handleMoveWorkspaceFolder(_event, request) {
  await ensureWorkspaceInitialized()

  const source = resolveWorkspacePath(request?.path, { allowRoot: true })
  if (!source.relativePath) {
    throw new Error('root folder cannot be moved')
  }

  const sourceStat = await fs.stat(source.absolutePath)
  if (!sourceStat.isDirectory()) {
    throw new Error('only workspace folders can be moved')
  }

  const sourceParentPath = path.posix.dirname(source.relativePath) === '.' ? '' : path.posix.dirname(source.relativePath)
  const sourceName = path.posix.basename(source.relativePath)
  const targetFolderPath = request?.target_folder === undefined
    ? sourceParentPath
    : normalizeWorkspacePath(request?.target_folder || '', { allowRoot: true })
  const requestedName = String(request?.target_name || '').trim() || sourceName
  const targetRelativePath = targetFolderPath ? `${targetFolderPath}/${requestedName}` : requestedName

  if (targetRelativePath === source.relativePath || targetRelativePath.startsWith(`${source.relativePath}/`)) {
    throw new Error('folder cannot be moved into itself')
  }

  const { absolutePath: targetFolderAbsolutePath } = resolveWorkspacePath(targetFolderPath, { allowRoot: true })
  await fs.mkdir(targetFolderAbsolutePath, { recursive: true })

  const finalName = (targetFolderPath === sourceParentPath && requestedName === sourceName)
    ? sourceName
    : await pickUniqueWorkspaceFolderTarget(targetFolderAbsolutePath, requestedName)
  const finalRelativePath = targetFolderPath ? `${targetFolderPath}/${finalName}` : finalName
  const finalAbsolutePath = path.join(targetFolderAbsolutePath, finalName)

  if (finalRelativePath === source.relativePath) {
    return {
      root_path: getWorkspaceRoot(),
      items: await readWorkspaceTree(),
      moved_path: source.relativePath,
    }
  }

  await fs.rename(source.absolutePath, finalAbsolutePath)

  return {
    root_path: getWorkspaceRoot(),
    items: await readWorkspaceTree(),
    moved_path: finalRelativePath,
  }
}

async function handleDeleteWorkspaceDocument(_event, request) {
  await ensureWorkspaceInitialized()

  const source = resolveWorkspacePath(request?.path)
  const sourceStat = await fs.stat(source.absolutePath)
  if (!sourceStat.isFile() || !isSupportedWorkspaceDocument(source.relativePath)) {
    throw new Error('only workspace files can be deleted')
  }

  const sourceParentPath = path.posix.dirname(source.relativePath) === '.' ? '' : path.posix.dirname(source.relativePath)
  const sourceStem = path.basename(source.relativePath, path.extname(source.relativePath))
  const sourceChildFolderRelativePath = sourceParentPath ? `${sourceParentPath}/${sourceStem}` : sourceStem
  const sourceChildFolder = resolveWorkspacePath(sourceChildFolderRelativePath, { allowRoot: true })

  await shell.trashItem(source.absolutePath)

  try {
    const childStat = await fs.stat(sourceChildFolder.absolutePath)
    if (childStat.isDirectory()) {
      await shell.trashItem(sourceChildFolder.absolutePath)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  return getWorkspaceDocumentListResponse()
}

async function handleDeleteWorkspaceFolder(_event, request) {
  await ensureWorkspaceInitialized()

  const source = resolveWorkspacePath(request?.path)
  if (!source.relativePath) {
    throw new Error('the workspace root cannot be deleted')
  }
  const sourceStat = await fs.stat(source.absolutePath)
  if (!sourceStat.isDirectory()) {
    throw new Error('only folders can be deleted here')
  }

  await shell.trashItem(source.absolutePath)

  return getWorkspaceDocumentListResponse()
}

async function handleOpenWorkspaceFile(_event, request) {
  await ensureWorkspaceInitialized()
  const { relativePath, absolutePath } = resolveWorkspacePath(request?.path)
  if (!isSupportedWorkspaceDocument(relativePath)) {
    throw new Error('unsupported workspace file')
  }
  return shell.openPath(absolutePath)
}

async function handleSaveWorkspaceAsset(_event, request) {
  await ensureWorkspaceInitialized()

  const mimeType = String(request?.mime_type || 'image/png')
  if (!mimeType.startsWith('image/')) {
    throw new Error('only image assets can be saved')
  }

  const assetsDir = path.join(getWorkspaceRoot(), 'assets')
  await fs.mkdir(assetsDir, { recursive: true })

  const requestedName = sanitizeWorkspaceAssetName(request?.filename || '', extensionFromMimeType(mimeType))
  const extension = path.extname(requestedName) || extensionFromMimeType(mimeType)
  const stem = path.basename(requestedName, extension) || 'image'
  const finalFilename = `${Date.now()}-${crypto.randomUUID()}-${stem}${extension}`
  const absolutePath = path.join(assetsDir, finalFilename)

  await fs.writeFile(absolutePath, Buffer.from(String(request?.base64_content || ''), 'base64'))

  const relativePath = `assets/${finalFilename}`
  return {
    path: relativePath,
    url: workspaceURLFromPath(relativePath),
    mime_type: mimeType,
  }
}

const maxImportFileBytes = 50 * 1024 * 1024

function sanitizeImportedWorkspaceFilename(filename) {
  const fallback = `imported-file-${Date.now()}`
  const raw = String(filename || '').trim()
  if (!raw) {
    return fallback
  }
  const extension = path.extname(raw)
  const stem = path.basename(raw, extension)
    .replace(/[<>:"/\\|?*\x00-]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || fallback
  return extension ? `${stem}${extension}` : stem
}

async function pickUniqueImportedFileTarget(folderAbsolutePath, requestedFilename) {
  const extension = path.extname(requestedFilename)
  const stem = path.basename(requestedFilename, extension)
  let finalFilename = requestedFilename
  let index = 2
  while (true) {
    try {
      await fs.access(path.join(folderAbsolutePath, finalFilename))
      finalFilename = `${stem} ${index}${extension}`
      index += 1
      continue
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return finalFilename
      }
      throw error
    }
  }
}

async function handleImportWorkspaceFile(_event, request) {
  await ensureWorkspaceInitialized()

  const folderRelativePath = String(request?.folder || '').trim()
  const requestedName = sanitizeImportedWorkspaceFilename(request?.filename || '')
  if (!isSupportedWorkspaceDocument(requestedName)) {
    throw new Error('unsupported workspace file type')
  }

  const { absolutePath: folderAbsolutePath } = folderRelativePath
    ? resolveWorkspacePath(folderRelativePath, { allowRoot: true })
    : { absolutePath: getWorkspaceRoot() }
  await fs.mkdir(folderAbsolutePath, { recursive: true })

  const finalFilename = await pickUniqueImportedFileTarget(folderAbsolutePath, requestedName)
  const targetAbsolutePath = path.join(folderAbsolutePath, finalFilename)

  if (request?.source_path) {
    const sourcePath = String(request.source_path)
    const stat = await fs.stat(sourcePath)
    if (!stat.isFile()) {
      throw new Error('source is not a file')
    }
    if (stat.size > maxImportFileBytes) {
      throw new Error('file exceeds 50 MB import limit')
    }
    await fs.copyFile(sourcePath, targetAbsolutePath)
  } else if (typeof request?.base64_content === 'string' && request.base64_content) {
    const buffer = Buffer.from(request.base64_content, 'base64')
    if (buffer.byteLength > maxImportFileBytes) {
      throw new Error('file exceeds 50 MB import limit')
    }
    await fs.writeFile(targetAbsolutePath, buffer)
  } else {
    throw new Error('missing source_path or base64_content')
  }

  const finalRelativePath = folderRelativePath ? `${folderRelativePath}/${finalFilename}` : finalFilename
  const list = await getWorkspaceDocumentListResponse()
  return {
    ...list,
    imported_path: finalRelativePath,
  }
}

async function handleChooseFilesToImport() {
  const result = await dialog.showOpenDialog({
    title: 'Select files to import',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled) {
    return { canceled: true, paths: [] }
  }
  return { canceled: false, paths: result.filePaths || [] }
}

function resolveWorkspaceProtocolPath(requestURL) {
  const parsedURL = new URL(requestURL)
  const hostname = decodeURIComponent(parsedURL.hostname || '')
  const pathname = decodeURIComponent(parsedURL.pathname || '').replace(/^\/+/, '')
  const relativePath = [hostname, pathname].filter(Boolean).join('/')
  return resolveWorkspacePath(relativePath)
}

function registerWorkspaceProtocolHandler() {
  protocol.handle('kition-workspace', (request) => {
    const { absolutePath } = resolveWorkspaceProtocolPath(request.url)
    return net.fetch(fileURLFromPath(absolutePath))
  })
}

function registerBundledAssetProtocolHandler() {
  const distDir = path.resolve(moduleDir, '..', 'dist')
  protocol.handle(
    KITION_BUNDLED_ASSET_SCHEME,
    (request) => createBundledAssetResponse(request.url, distDir),
  )
}

async function handleRevealWorkspaceFolder(_event, request) {
  await ensureWorkspaceInitialized()
  if (request?.path) {
    const { absolutePath } = resolveWorkspacePath(request.path, { allowRoot: true })
    const itemStat = await fs.stat(absolutePath)
    if (itemStat.isDirectory()) {
      return shell.openPath(absolutePath)
    }
    shell.showItemInFolder(absolutePath)
    return ''
  }
  return shell.openPath(getWorkspaceRoot())
}

async function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.desktopInfo, () => ({
    is_desktop: true,
    platform: desktopEnv.platform,
    backend_base_url: getBackendBaseURL(),
    data_dir: desktopEnv.data_dir,
    cache_dir: desktopEnv.cache_dir,
    logs_dir: desktopEnv.logs_dir,
    uploads_dir: desktopEnv.uploads_dir,
    exports_dir: desktopEnv.exports_dir,
    workspace_dir: desktopEnv.workspace_dir,
    app_version: app.getVersion(),
    supports_secure_storage: true,
  }))
  ipcMain.handle(IPC_CHANNELS.backendStatus, () => backendSupervisor.status())
  ipcMain.handle(IPC_CHANNELS.retryBackendStart, async () => backendSupervisor.retry())
  ipcMain.handle(IPC_CHANNELS.openExternalURL, async (_event, url) => {
    await shell.openExternal(normalizeExternalURL(url))
  })
  ipcMain.handle(IPC_CHANNELS.showNotification, async (_event, title, message) => {
    if (Notification.isSupported()) {
      new Notification({ title, body: message }).show()
    }
  })
  ipcMain.handle(IPC_CHANNELS.windowAction, async (_event, action) => handleWindowAction(action))
  ipcMain.handle(IPC_CHANNELS.openRuntimePath, async (_event, kind) => handleOpenRuntimePath(kind))
  ipcMain.handle(IPC_CHANNELS.bootstrapInitialize, () => bootstrap.initialize())
  ipcMain.handle(IPC_CHANNELS.bootstrapCreateAttestation, (_event, request) => bootstrap.createAttestation(request))
  ipcMain.handle(IPC_CHANNELS.bootstrapStatus, () => bootstrap.status())
  ipcMain.handle(IPC_CHANNELS.saveTextFile, handleSaveTextFile)
  ipcMain.handle(IPC_CHANNELS.saveBinaryFile, handleSaveBinaryFile)
  ipcMain.handle(IPC_CHANNELS.savePdfFile, handleSavePdfFile)
  ipcMain.handle(IPC_CHANNELS.copyDocumentHtml, handleCopyDocumentHtml)
  ipcMain.handle(IPC_CHANNELS.copyImage, handleCopyImage)
  ipcMain.handle(IPC_CHANNELS.listWorkspaceDocuments, handleListWorkspaceDocuments)
  ipcMain.handle(IPC_CHANNELS.readWorkspaceDocument, handleReadWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.statWorkspaceDocument, handleStatWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.writeWorkspaceDocument, handleWriteWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.createWorkspaceDocument, handleCreateWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.createWorkspaceFolder, handleCreateWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.moveWorkspaceDocument, handleMoveWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.moveWorkspaceFolder, handleMoveWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.deleteWorkspaceDocument, handleDeleteWorkspaceDocument)
  ipcMain.handle(IPC_CHANNELS.deleteWorkspaceFolder, handleDeleteWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.openWorkspaceFile, handleOpenWorkspaceFile)
  ipcMain.handle(IPC_CHANNELS.saveWorkspaceAsset, handleSaveWorkspaceAsset)
  ipcMain.handle(IPC_CHANNELS.importWorkspaceFile, handleImportWorkspaceFile)
  ipcMain.handle(IPC_CHANNELS.chooseFilesToImport, handleChooseFilesToImport)
  ipcMain.handle(IPC_CHANNELS.revealWorkspaceFolder, handleRevealWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.chooseWorkspaceFolder, handleChooseWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.setWorkspaceFolder, handleSetWorkspaceFolder)
  ipcMain.handle(IPC_CHANNELS.listVaults, handleListVaults)
  ipcMain.handle(IPC_CHANNELS.addVault, handleAddVault)
  ipcMain.handle(IPC_CHANNELS.removeVault, handleRemoveVault)
  ipcMain.handle(IPC_CHANNELS.renameVault, handleRenameVault)
  ipcMain.handle(IPC_CHANNELS.setActiveVault, handleSetActiveVault)
  ipcMain.handle(IPC_CHANNELS.chooseDirectory, handleChooseDirectory)
  ipcMain.handle(IPC_CHANNELS.storeSecureValue, (_event, key, value) => secureStore.set(key, value))
  ipcMain.handle(IPC_CHANNELS.readSecureValue, (_event, key) => secureStore.get(key))
  ipcMain.handle(IPC_CHANNELS.deleteSecureValue, (_event, key) => secureStore.delete(key))
  ipcMain.handle(IPC_CHANNELS.browserSessionStatus, (_event, request) => handleBrowserSessionStatus(request))
  ipcMain.handle(IPC_CHANNELS.ensureBrowserSessionWindow, (_event, request) => handleEnsureBrowserSessionWindow(request))
  ipcMain.handle(IPC_CHANNELS.openBrowserSessionHome, (_event, request) => handleOpenBrowserSessionHome(request))
  ipcMain.handle(IPC_CHANNELS.hideBrowserSessionPanel, (_event, request) => handleHideBrowserSessionPanel(request))
  ipcMain.handle(IPC_CHANNELS.goBackBrowserSession, (_event, request) => handleGoBackBrowserSession(request))
  ipcMain.handle(IPC_CHANNELS.goForwardBrowserSession, (_event, request) => handleGoForwardBrowserSession(request))
  ipcMain.handle(IPC_CHANNELS.reloadBrowserSession, (_event, request) => handleReloadBrowserSession(request))
  ipcMain.handle(IPC_CHANNELS.stopBrowserSession, (_event, request) => handleStopBrowserSession(request))
  ipcMain.handle(IPC_CHANNELS.setBrowserSessionHostLayout, (_event, request) => handleSetBrowserSessionHostLayout(request))
  ipcMain.handle(IPC_CHANNELS.extractBrowserPageContext, (_event, request) => handleExtractBrowserPageContext(request))
  ipcMain.handle(IPC_CHANNELS.setBrowserSessionTestMock, handleSetBrowserSessionTestMock)
  ipcMain.handle(IPC_CHANNELS.listBrowserSites, () => handleListBrowserSites())
  ipcMain.handle(IPC_CHANNELS.forgetBrowserSite, (_event, request) => handleForgetBrowserSite(request))
  ipcMain.handle(IPC_CHANNELS.refreshBrowserSiteLoginStatus, (_event, request) => handleRefreshBrowserSiteLoginStatus(request))
  ipcMain.handle(IPC_CHANNELS.updatesGetState, () => updateManager?.state ?? { phase: 'idle' })
  ipcMain.handle(IPC_CHANNELS.updatesCheck, () => updateManager?.check())
  ipcMain.handle(IPC_CHANNELS.updatesDownload, () => updateManager?.download())
  ipcMain.handle(IPC_CHANNELS.updatesInstall, async () => {
    await browserSessions?.shutdown()
    await backendSupervisor?.stop()
    updateManager?.quitAndInstall()
  })
  ipcMain.handle(IPC_CHANNELS.updatesSetBetaChannel, (_event, enabled) => {
    cachedBetaChannel = Boolean(enabled)
    return updateManager?.setBetaChannel(cachedBetaChannel)
  })
  ipcMain.handle(IPC_CHANNELS.updatesSetAutoCheck, (_event, enabled) => {
    cachedAutoCheck = Boolean(enabled)
  })
  ipcMain.handle(IPC_CHANNELS.proxyGet, async () => {
    await proxyManager.load()
    return proxyManager.state()
  })
  ipcMain.handle(IPC_CHANNELS.proxySave, async (_event, payload) => {
    await proxyManager.load()
    const previous = proxyManager.state()
    const next = await proxyManager.save(payload)
    const passwordChanged = payload && typeof payload === 'object' && payload.password !== undefined
    const requiresRestart = proxyManager.requiresBackendRestart(previous, next, passwordChanged)
    await proxyManager.apply()
    return { state: next, requiresRestart }
  })
  ipcMain.handle(IPC_CHANNELS.proxyTest, async (_event, payload) => proxyManager.test(payload))
  ipcMain.handle(IPC_CHANNELS.proxyRestartBackend, async () => {
    if (!backendSupervisor) {
      return { ok: false, message: 'backend supervisor unavailable' }
    }
    try {
      await backendSupervisor.retry()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error?.message || String(error) }
    }
  })
}

async function bootstrapElectron() {
  desktopEnv = await resolveDesktopEnvironment()
  registerBundledAssetProtocolHandler()
  registerWorkspaceProtocolHandler()
  secureStore = new SecureStore(desktopEnv)
  await secureStore.initialize()
  bootstrap = new CommunityBootstrap(desktopEnv.data_dir)
  workspaceRegistry = new WorkspaceRegistry(desktopEnv.data_dir)
  const registryState = await workspaceRegistry.load()
  const defaultVaultPath = path.join(desktopEnv.data_dir, 'workspace')
  await workspaceRegistry.seedDefaultVault(defaultVaultPath)
  let activeVaultPath = registryState?.active_vault_path || ''
  if (activeVaultPath) {
    try {
      const stats = await fs.stat(activeVaultPath)
      if (stats.isDirectory()) {
        desktopEnv.workspace_dir = activeVaultPath
      } else {
        await workspaceRegistry.clearActiveVault()
        activeVaultPath = ''
      }
    } catch {
      await workspaceRegistry.clearActiveVault()
      activeVaultPath = ''
    }
  }
  if (!activeVaultPath && workspaceRegistry.wasMissing) {
    try {
      await fs.mkdir(defaultVaultPath, { recursive: true })
      await workspaceRegistry.setActiveVault(defaultVaultPath)
      desktopEnv.workspace_dir = defaultVaultPath
    } catch (error) {
      console.warn('failed to seed default workspace:', error?.message || error)
    }
  }
  backendSupervisor = new BackendSupervisor(desktopEnv)
  proxyManager = new ProxyManager({
    env: desktopEnv,
    secureStore,
    getSession: () => session.defaultSession,
    getMainWindow: () => mainWindow,
  })
  await proxyManager.load()
  // Tell the supervisor to pull env overrides from the proxy manager on every
  // spawn — that's how `https_proxy` / `KITION_SMTP_PROXY` propagate into the
  // Go API subprocess after the user changes the proxy and we restart.
  backendSupervisor.extraEnvProvider = () => proxyManager.envOverrides()
  browserSessions = new BrowserSessionManager(desktopEnv, () => mainWindow, {
    configureSession: (browserSession) => proxyManager.applyToSession(browserSession),
  })
  updateManager = new UpdateManager({
    getMainWindow: () => mainWindow,
    getBetaChannel: () => cachedBetaChannel,
    getAutoCheck: () => cachedAutoCheck,
    isPackaged: app.isPackaged,
  })
  updateManager.bindEvents()

  await registerIpcHandlers()
  // Apply proxy BEFORE the Go API starts — that way the supervisor's
  // env-override hook sees the right values on first launch.
  await proxyManager.apply()
  await backendSupervisor.start()
  await createMainWindow()
  void updateManager.start()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isDesktopTestMode) {
    app.quit()
  }
})

app.on('activate', () => {
  if (!mainWindow) {
    void createMainWindow()
  }
})

app.on('before-quit', createBeforeQuitHandler({
  app,
  cleanup: async () => {
    updateManager?.stop()
    if (workspaceWatcher) {
      try { await workspaceWatcher.close() } catch {}
      workspaceWatcher = null
    }
    await browserSessions?.shutdown()
    await backendSupervisor?.stop()
  },
  onError: (error) => {
    console.error('failed to cleanly stop desktop services:', error?.message || error)
  },
}))

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock?.setIcon) {
    try {
      app.dock.setIcon(path.join(moduleDir, 'icon.png'))
    } catch {}
  }
  registerKitionProtocolClient()
  await bootstrapElectron()
  if (pendingKitionDeepLink) {
    await focusKitionWindow(pendingKitionDeepLink)
  }
})
