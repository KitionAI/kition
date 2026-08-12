import { getCurrentLocale } from '@/i18n'
import { resolveBundledAssetURL } from '@/lib/bundledAssets'
import type { AgentLocalSource } from '@/api/agent'

type KitionDesktopBridge = {
  shell?: string
  backendOrigin?: string
  DesktopInfo?: () => Promise<DesktopInfo>
  BackendStatus?: () => Promise<DesktopBackendStatus>
  RetryBackendStart?: () => Promise<DesktopBackendStatus>
  OpenExternalURL?: (url: string) => Promise<void>
  ShowNotification?: (title: string, message: string) => Promise<void>
  WindowAction?: (action: string) => Promise<void>
  OpenRuntimePath?: (kind: string) => Promise<void>
  BootstrapInitialize?: () => Promise<BootstrapInitializeResult>
  BootstrapCreateAttestation?: (request: BootstrapAttestationRequest) => Promise<BootstrapAttestationResult>
  BootstrapStatus?: () => Promise<BootstrapStatus>
  SaveTextFile?: (dialogTitle: string, defaultFilename: string, content: string) => Promise<string>
  SaveBinaryFile?: (request: SaveFileRequest) => Promise<string>
  SavePdfFile?: (request: SavePdfFileRequest) => Promise<string>
  CopyDocumentHtml?: (request: CopyDocumentHtmlRequest) => Promise<boolean>
  CopyImage?: (request: { url: string }) => Promise<boolean>
  SubmitFeedback?: (request: FeedbackReportSubmissionRequest) => Promise<FeedbackReportSubmissionResponse>
  ListWorkspaceDocuments?: () => Promise<WorkspaceDocumentListResponse>
  ReadWorkspaceDocument?: (request: WorkspaceDocumentPathRequest) => Promise<WorkspaceDocument>
  StatWorkspaceDocument?: (request: { path: string }) => Promise<{ mtime_ms: number; size: number } | null>
  WriteWorkspaceDocument?: (request: WorkspaceDocumentWriteRequest) => Promise<WorkspaceDocument>
  CreateWorkspaceDocument?: (request: WorkspaceDocumentCreateRequest) => Promise<WorkspaceDocument>
  CreateWorkspaceFolder?: (request: WorkspaceFolderCreateRequest) => Promise<WorkspaceFolderCreateResponse>
  MoveWorkspaceDocument?: (request: WorkspaceDocumentMoveRequest) => Promise<WorkspaceDocument>
  MoveWorkspaceFolder?: (request: WorkspaceFolderMoveRequest) => Promise<WorkspaceFolderMoveResponse>
  DeleteWorkspaceDocument?: (request: WorkspaceDocumentPathRequest) => Promise<WorkspaceDocumentListResponse>
  DeleteWorkspaceFolder?: (request: WorkspaceFolderRequest) => Promise<WorkspaceDocumentListResponse>
  OpenWorkspaceFile?: (request: WorkspaceDocumentPathRequest) => Promise<string>
  SaveWorkspaceAsset?: (request: WorkspaceAssetSaveRequest) => Promise<WorkspaceAsset>
  ImportWorkspaceFile?: (request: WorkspaceFileImportRequest) => Promise<WorkspaceFileImportResponse>
  ChooseFilesToImport?: () => Promise<WorkspaceFileChooseResponse>
  RevealWorkspaceFolder?: (request?: Partial<WorkspaceDocumentPathRequest>) => Promise<string>
  ChooseWorkspaceFolder?: () => Promise<WorkspaceDocumentListResponse | null>
  SetWorkspaceFolder?: (request: WorkspaceFolderRequest) => Promise<WorkspaceDocumentListResponse>
  ListVaults?: () => Promise<VaultListResponse>
  AddVault?: (request: VaultAddRequest) => Promise<VaultMutationResponse>
  RemoveVault?: (request: VaultPathRequest) => Promise<VaultListResponse>
  RenameVault?: (request: VaultRenameRequest) => Promise<VaultMutationResponse>
  SetActiveVault?: (request: VaultPathRequest) => Promise<SetActiveVaultResponse>
  ChooseDirectory?: (request?: ChooseDirectoryRequest) => Promise<ChooseDirectoryResponse>
  ChooseAgentAnalysisDirectory?: (request?: AgentAnalysisDirectoryRequest) => Promise<AgentLocalSource | null>
  StoreSecureValue?: (key: string, value: string) => Promise<void>
  ReadSecureValue?: (key: string) => Promise<string>
  DeleteSecureValue?: (key: string) => Promise<void>
  BrowserSessionStatus?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  EnsureBrowserSessionWindow?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  OpenBrowserSessionHome?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  HideBrowserSessionPanel?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  GoBackBrowserSession?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  GoForwardBrowserSession?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  ReloadBrowserSession?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  StopBrowserSession?: (request: BrowserSessionRequest) => Promise<BrowserSessionStatus>
  SetBrowserSessionHostLayout?: (request: BrowserSessionHostLayoutRequest) => Promise<BrowserSessionStatus>
  ExtractBrowserPageContext?: (request: BrowserPageContextRequest) => Promise<BrowserPageContext>
  ListBrowserSites?: () => Promise<BrowserSiteListResponse>
  ForgetBrowserSite?: (request: BrowserSiteForgetRequest) => Promise<BrowserSiteListResponse>
  RefreshBrowserSiteLoginStatus?: (request: BrowserSiteRefreshRequest) => Promise<BrowserSiteListResponse>
  EventsOn?: (eventName: string, callback: (payload: any) => void) => (() => void) | void
  documentExternalChangeEvent?: string
  BrowserOpenURL?: (url: string) => void
}

export type DesktopInfo = {
  is_desktop: boolean
  platform: string
  backend_base_url: string
  data_dir: string
  cache_dir: string
  logs_dir: string
  uploads_dir: string
  exports_dir: string
  workspace_dir?: string
  app_version?: string
  supports_secure_storage: boolean
}

export type WorkspaceDocumentTreeItem = {
  type: 'folder' | 'file'
  path: string
  name: string
  format?: WorkspaceDocumentFormat
  size?: number
  updated_at?: string
  children?: WorkspaceDocumentTreeItem[]
}

export type WorkspaceDocumentListResponse = {
  root_path: string
  items: WorkspaceDocumentTreeItem[]
}

export type WorkspaceDocument = {
  path: string
  name: string
  content: string
  format?: WorkspaceDocumentFormat
  updated_at?: string
  size?: number
  mtime_ms?: number
}

export type WorkspaceDocumentExternalChange = {
  path: string
  eventType: 'add' | 'change' | 'unlink'
  mtimeMs?: number
}

export type WorkspaceDocumentFormat =
  | 'markdown'
  | 'data'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'csv'
  | 'json'
  | 'text'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'binary'
  | 'table'

export type WorkspaceDocumentPathRequest = {
  path: string
}

export type WorkspaceFolderRequest = {
  path: string
}

export type VaultEntry = {
  path: string
  name: string
  added_at: string
  last_opened_at: string
}

export type VaultListResponse = {
  vaults: VaultEntry[]
  active_vault_path: string
}

export type VaultPathRequest = {
  path: string
}

export type VaultAddRequest = {
  path?: string
  parent_path?: string
  name?: string
}

export type VaultRenameRequest = {
  path: string
  name: string
}

export type VaultMutationResponse = {
  vault: VaultEntry
  registry: VaultListResponse
}

export type SetActiveVaultResponse = {
  list: WorkspaceDocumentListResponse
  registry: VaultListResponse
}

export type ChooseDirectoryRequest = {
  title?: string
}

export type ChooseDirectoryResponse = {
  canceled: boolean
  path: string
}

export type AgentAnalysisDirectoryRequest = {
  suggested_path?: string
}

export type WorkspaceDocumentWriteRequest = {
  path: string
  content: string
}

export type WorkspaceDocumentCreateRequest = {
  title?: string
  folder?: string
  platform?: string
  format?: WorkspaceDocumentFormat
}

export type WorkspaceFolderCreateRequest = {
  parent_folder?: string
  name?: string
}

export type WorkspaceFolderCreateResponse = WorkspaceDocumentListResponse & {
  created_path: string
}

export type WorkspaceDocumentMoveRequest = {
  path: string
  target_folder?: string
  target_name?: string
}

export type WorkspaceFolderMoveRequest = {
  path: string
  target_folder?: string
  target_name?: string
}

export type WorkspaceFolderMoveResponse = WorkspaceDocumentListResponse & {
  moved_path: string
}

export type WorkspaceAssetSaveRequest = {
  document_path?: string
  filename?: string
  mime_type: string
  base64_content: string
}

export type WorkspaceAsset = {
  path: string
  url: string
  mime_type: string
}

export type WorkspaceFileImportRequest = {
  folder?: string
  filename: string
  source_path?: string
  base64_content?: string
}

export type WorkspaceFileImportResponse = WorkspaceDocumentListResponse & {
  imported_path: string
}

export type WorkspaceFileChooseResponse = {
  canceled: boolean
  paths: string[]
}

export type DesktopBackendStatus = {
  base_url: string
  health_url: string
  running: boolean
  last_error: string
  logs: string
  log_file: string
  launch_mode: string
  binary_path: string
  config_path: string
  working_dir: string
  command: string
  runtime_version?: string
  protocol_version?: number
  capabilities?: string[]
  runtime_sha256?: string
  runtime_label?: 'local-runtime' | 'dev-runtime' | ''
}

export type BrowserSessionProvider = 'generic-web' | (string & {})

export type BrowserSessionRequest = {
  provider: BrowserSessionProvider
  profile_id?: string
  host?: string
  url?: string
  page_url?: string
  address?: string
  command?: string
  query?: string
  adapter?: string
}

export type BrowserSessionStatus = {
  provider: BrowserSessionProvider
  profile_id?: string
  supported: boolean
  driver?: string
  available: boolean
  window_open: boolean
  panel_visible?: boolean
  panel_width?: number
  logged_in: boolean
  editor_ready?: boolean
  can_go_back?: boolean
  can_go_forward?: boolean
  is_loading?: boolean
  page_url: string
  page_title: string
  message: string
  last_error: string
  runtime?: Record<string, any>
}

export type BrowserSessionPanelState = {
  provider: BrowserSessionProvider
  visible: boolean
  width: number
  title: string
  url: string
  canGoBack?: boolean
  canGoForward?: boolean
  isLoading?: boolean
  windowOpen?: boolean
  loggedIn?: boolean
  message?: string
  lastError?: string
  runtime?: Record<string, any>
}

export type BrowserSessionHostLayoutRequest = BrowserSessionRequest & {
  leftInset?: number
  topInset?: number
  rightInset?: number
}

export type BrowserPageContextRequest = BrowserSessionRequest & {
  adapter?: string
  command?: string
  query?: string
  entity_type?: string
  max_preview_length?: number
  max_content_length?: number
  max_links?: number
}

export type BrowserSite = {
  host: string
  profileId: string
  url: string
  title: string
  favicon: string
  provider: BrowserSessionProvider
  firstSeenAt: string
  lastSeenAt: string
  visitCount: number
  loggedIn: boolean
  lastCheckedAt: string
}

export type BrowserSiteListResponse = {
  sites: BrowserSite[]
}

export type BrowserSiteForgetRequest = {
  host: string
  profile_id?: string
}

export type BrowserSiteRefreshRequest = {
  host?: string
}

export type BrowserPageEntity = {
  entity_type?: string
  url?: string
  title?: string
  author?: string
  published_at?: string
  summary?: string
}

export type BrowserPageContentBlock = {
  url?: string
  title?: string
  summary?: string
  text?: string
  html?: string
}

export type BrowserPageContext = {
  provider?: BrowserSessionProvider
  profile_id?: string
  supported_page: boolean
  logged_in: boolean
  editor_ready: boolean
  title_ready?: boolean
  content_ready?: boolean
  longform_entry_available?: boolean
  page_url: string
  page_title: string
  hostname?: string
  page_heading?: string
  title_text?: string
  content_text_preview?: string
  visible_text_preview?: string
  main_content_html?: string
  html_snapshot?: string
  content_blocks?: BrowserPageContentBlock[]
  page_type?: string
  links?: Array<{
    text: string
    href: string
  }>
  extracted_entities?: BrowserPageEntity[]
  extracted_at?: string
}

export type BootstrapDiagnostics = {
  code: string
  title: string
  message: string
  detail: string
  support_id: string
  retryable: boolean
  next_action: string
}

export type BootstrapStatus = {
  official_build: boolean
  build_channel: string
  available: boolean
  state: string
  installation_id: string
  diagnostics: BootstrapDiagnostics
}

export type BootstrapInitializeResult = {
  installation_id: string
  status: BootstrapStatus
}

export type BootstrapAttestationRequest = {
  startup_id: string
  challenge_id: string
  challenge: string
  expires_at: string
}

export type BootstrapAttestationPayload = {
  schema_version: string
  module_version: string
  integrity: {
    packaged: boolean
    signature_present: boolean
    debugger_detected: boolean
    tamper_flags: string[]
  }
  hardware: {
    hardware_uuid_hash: string
    serial_hash: string
    board_serial_hash: string
    mac_hashes: string[]
  }
  proof: {
    challenge_binding: string
    attestation_signature: string
  }
}

export type BootstrapAttestationResult = {
  status: BootstrapStatus
  attestation?: BootstrapAttestationPayload
}

type SaveFileRequest = {
  dialog_title: string
  default_filename: string
  base64_content: string
}

type SavePdfFileRequest = {
  dialog_title: string
  default_filename: string
  html: string
  page_format?: string
  document_path?: string
  landscape?: boolean
  margins_type?: 0 | 1 | 2
  scale_factor?: number
}

type CopyDocumentHtmlRequest = {
  html: string
  text: string
  document_path?: string
}

export type FeedbackReportSubmissionRequest = {
  description: string
  contact_email?: string
  access_token?: string
}

export type FeedbackReportSubmissionResponse = {
  ticket_id: string
  accepted_at: string
}

declare global {
  interface Window {
    kitionDesktop?: KitionDesktopBridge
  }
}

const desktopBackendOriginFallback = 'http://127.0.0.1:18101'
const apiPrefix = '/api'
const backendHealthPath = '/health'
const DESKTOP_BROWSER_SESSION_EVENT = 'desktop:browser:session-state-updated'
let desktopBackendReadyPromise: Promise<boolean> | null = null
const browserSessionStateHandlers = new Map<
  string,
  Set<(state: BrowserSessionPanelState) => void>
>()
let browserSessionStateBridgeBound = false

export function normalizeDesktopPlatform(platform?: string | null) {
  const normalized = String(platform || '').trim().toLowerCase()
  switch (normalized) {
    case 'win32':
      return 'windows'
    case 'macos':
    case 'mac':
    case 'osx':
      return 'darwin'
    default:
      return normalized
  }
}

function getDesktopBridge(): KitionDesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.kitionDesktop : undefined
}

export function isDesktopRuntime() {
  return Boolean(getDesktopBridge())
}

export function isElectronDesktopRuntime() {
  return getDesktopBridge()?.shell === 'electron'
}

function getDesktopBackendOrigin() {
  return getDesktopBridge()?.backendOrigin || desktopBackendOriginFallback
}

export function normalizeApiPath(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith(apiPrefix)
    ? path.slice(apiPrefix.length)
    : path

  if (!normalizedPath) {
    return '/'
  }

  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
}

function getLocalE2EApiBaseURL() {
  if (typeof window === 'undefined') {
    return ''
  }
  return String(window.localStorage.getItem('kition.e2e.apiBaseUrl') || '').trim().replace(/\/+$/, '')
}

export function getApiBaseURL() {
  const e2eBaseURL = getLocalE2EApiBaseURL()
  if (e2eBaseURL) {
    return e2eBaseURL
  }
  return isDesktopRuntime() ? `${getDesktopBackendOrigin()}${apiPrefix}` : apiPrefix
}

export function resolveApiURL(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  return `${getApiBaseURL()}${normalizeApiPath(path)}`
}

export function resolvePublicFileURL(path: string) {
  const bundledAssetPath = path.match(/^kition-bundled:(\/?[^?#]+(?:[?#].*)?)$/i)?.[1]
  if (bundledAssetPath) {
    return resolveBundledAssetURL(bundledAssetPath)
  }
  if (/^(https?:|data:|blob:|kition-workspace:)/i.test(path)) {
    return path
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return isDesktopRuntime() ? `${getDesktopBackendOrigin()}${normalizedPath}` : normalizedPath
}

export function getDesktopBackendHealthURL() {
  return `${getDesktopBackendOrigin()}${backendHealthPath}`
}

export async function waitForDesktopBackendReady(timeoutMs = 15000) {
  if (!isDesktopRuntime()) {
    return true
  }

  if (!desktopBackendReadyPromise) {
    desktopBackendReadyPromise = (async () => {
      const deadline = Date.now() + timeoutMs
      let hasRetriedStart = false

      while (Date.now() < deadline) {
        try {
          const status = await getDesktopBackendStatus()
          if (status?.launch_mode === 'skip_api') {
            return true
          }
          if (!hasRetriedStart && status && !status.running) {
            hasRetriedStart = true
            await retryDesktopBackendStart().catch(() => null)
            continue
          }
        } catch {
          // Fall through to the health check retry loop.
        }

        try {
          const response = await fetch(getDesktopBackendHealthURL(), { method: 'GET' })
          if (response.ok) {
            return true
          }
        } catch {
          // Backend is still booting. Retry shortly.
        }

        if (!hasRetriedStart) {
          hasRetriedStart = true
          await retryDesktopBackendStart().catch(() => null)
        }

        await new Promise((resolve) => window.setTimeout(resolve, 300))
      }
      return false
    })()
  }

  try {
    return await desktopBackendReadyPromise
  } finally {
    desktopBackendReadyPromise = null
  }
}

export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.DesktopInfo) {
    return null
  }
  const info = await bridge.DesktopInfo()
  return {
    ...info,
    platform: normalizeDesktopPlatform(info.platform),
  }
}

export async function getDesktopBackendStatus(): Promise<DesktopBackendStatus | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.BackendStatus) {
    return null
  }
  return bridge.BackendStatus()
}

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

export async function retryDesktopBackendStart(): Promise<DesktopBackendStatus | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.RetryBackendStart) {
    return null
  }
  return bridge.RetryBackendStart()
}

export async function initializeDesktopBootstrap() {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapInitialize) {
    throw new Error('desktop bootstrap is unavailable')
  }
  return bridge.BootstrapInitialize()
}

export async function createDesktopBootstrapAttestation(request: BootstrapAttestationRequest) {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapCreateAttestation) {
    throw new Error('desktop bootstrap attestation is unavailable')
  }
  return bridge.BootstrapCreateAttestation(request)
}

export async function getDesktopBootstrapStatus() {
  const bridge = getDesktopBridge()
  if (!bridge?.BootstrapStatus) {
    throw new Error('desktop bootstrap status is unavailable')
  }
  return bridge.BootstrapStatus()
}

export async function openExternalURL(url: string) {
  const bridge = getDesktopBridge()
  if (bridge?.OpenExternalURL) {
    await bridge.OpenExternalURL(url)
    return
  }

  if (bridge?.BrowserOpenURL) {
    bridge.BrowserOpenURL(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function submitFeedbackReport(request: FeedbackReportSubmissionRequest) {
  const bridge = getDesktopBridge()
  if (bridge?.SubmitFeedback) {
    return bridge.SubmitFeedback(request)
  }

  const accessToken = String(request.access_token || '').trim()
  const path = accessToken ? '/api/issue-reports' : '/api/issue-reports/anonymous'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
  }
  const response = await fetch(`https://kition.ai${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      schema_version: 1,
      requestId: '',
      taskId: '',
      runtimeMode: 'hosted',
      errorCode: '',
      errorMessage: '',
      description: request.description,
      contactEmail: request.contact_email || '',
      timestamp: new Date().toISOString(),
      via: 'web',
    }),
  })
  const body = await response.json().catch(() => ({})) as {
    data?: { ticketId?: string; accepted_at?: string }
    error?: string
  }
  if (!response.ok) {
    throw new Error(body.error || `feedback submission failed (${response.status})`)
  }
  const ticketId = String(body.data?.ticketId || '').trim()
  if (!ticketId) {
    throw new Error('feedback service returned an invalid response')
  }
  return {
    ticket_id: ticketId,
    accepted_at: String(body.data?.accepted_at || ''),
  }
}

export async function showDesktopNotification(title: string, message: string) {
  const bridge = getDesktopBridge()
  if (bridge?.ShowNotification) {
    await bridge.ShowNotification(title, message)
  }
}

export async function triggerWindowAction(action: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.WindowAction) {
    return
  }
  await bridge.WindowAction(action)
}

export async function openRuntimePath(kind: 'data' | 'cache' | 'logs' | 'exports') {
  const bridge = getDesktopBridge()
  if (!bridge?.OpenRuntimePath) {
    return
  }
  await bridge.OpenRuntimePath(kind)
}

const browserWorkspaceStorageKey = 'kition.workspace.documents.v1'
const browserWorkspaceFolderStorageKey = 'kition.workspace.folders.v1'

type BrowserWorkspaceRecord = {
  content: string
  updated_at: string
}

function inferWorkspaceDocumentFormat(path: string): WorkspaceDocumentFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.kitable')) return 'data'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx'
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return 'pptx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.txt')) return 'text'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) return 'image'
  if (/\.(mp4|mov|webm)$/i.test(lower)) return 'video'
  if (/\.(mp3|wav|m4a)$/i.test(lower)) return 'audio'
  return 'binary'
}

function normalizeWorkspaceDocumentPath(path: string) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

function getBrowserWorkspaceParentPath(path: string) {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

function getBrowserWorkspaceStem(path: string) {
  const filename = path.split('/').pop() || path
  return filename.replace(/\.(md|markdown|kitable)$/i, '')
}

function pickUniqueBrowserWorkspaceDocumentPath(
  records: Record<string, BrowserWorkspaceRecord>,
  targetFolder: string,
  filename: string,
) {
  const extensionMatch = filename.match(/\.(md|markdown|kitable)$/i)
  const extension = extensionMatch?.[0] || '.md'
  const stem = extensionMatch ? filename.slice(0, -extension.length) : filename
  const normalizedFilename = extensionMatch ? filename : `${filename}${extension}`
  let finalFilename = normalizedFilename
  let index = 2

  while (records[targetFolder ? `${targetFolder}/${finalFilename}` : finalFilename]) {
    finalFilename = `${stem} ${index}${extension}`
    index += 1
  }

  return targetFolder ? `${targetFolder}/${finalFilename}` : finalFilename
}

function createSeededBrowserWorkspaceDocuments(now: string): Record<string, BrowserWorkspaceRecord> {
  return {
    'index.md': {
      updated_at: now,
      content: [
        '# Kition document library',
        '',
        'Local Markdown document library. The desktop app saves to the app data directory; the browser dev mode keeps a copy in localStorage.',
        '',
        '## Getting started',
        '',
        '- Open or edit documents from the left',
        '- Create folders on demand for organization',
        '- Knowledge pages, idea notes, and assets can all live in the same workspace',
      ].join('\n'),
    },
    'complex-document-template.md': {
      updated_at: now,
      content: [
        '# Complex document title',
        '',
        'Type: knowledge page',
        'Status: draft',
        'Tags: #knowledge-base #longform',
        '',
        '## Background',
        '',
        'Start by describing the problem this document addresses, its scope, and the key constraints.',
        '',
        '## Structure',
        '',
        '- Goals',
        '- Decisions',
        '- Tasks',
        '- Risks',
      ].join('\n'),
    },
    'inbox.md': {
      updated_at: now,
      content: [
        '# Idea inbox',
        '',
        'Type: idea note',
        'Status: draft',
        'Tags: #inbox #note',
        '',
        '## To triage',
        '',
        'Drop loose ideas here first, then move them into specific knowledge pages later.',
      ].join('\n'),
    },
  }
}

const legacyKnowledgeDirectory = String.fromCodePoint(0x77e5, 0x8bc6, 0x5e93)
const legacyKnowledgeFile = String.fromCodePoint(0x590d, 0x6742, 0x6587, 0x6863, 0x6a21, 0x677f, 0x2e, 0x6d, 0x64)
const legacyIdeasDirectory = String.fromCodePoint(0x7075, 0x611f, 0x7b14, 0x8bb0)
const legacyInboxFile = String.fromCodePoint(0x6536, 0x4ef6, 0x7bb1, 0x2e, 0x6d, 0x64)

function migrateLegacyBrowserWorkspaceDocuments(records: Record<string, BrowserWorkspaceRecord>) {
  const nextRecords = { ...records }
  let changed = false

  const migrations = [
    [`${legacyKnowledgeDirectory}/${legacyKnowledgeFile}`, legacyKnowledgeFile],
    [`${legacyIdeasDirectory}/${legacyInboxFile}`, legacyInboxFile],
  ] as const

  migrations.forEach(([legacyPath, nextPath]) => {
    if (!nextRecords[legacyPath]) {
      return
    }
    if (!nextRecords[nextPath]) {
      nextRecords[nextPath] = nextRecords[legacyPath]
    }
    delete nextRecords[legacyPath]
    changed = true
  })

  return { records: nextRecords, changed }
}

function cleanupLegacyBrowserSeedFolders(records: Record<string, BrowserWorkspaceRecord>) {
  if (typeof window === 'undefined') {
    return
  }

  const staleRootFolders = [
    records[`${legacyKnowledgeDirectory}/${legacyKnowledgeFile}`] ? legacyKnowledgeDirectory : '',
    records[`${legacyIdeasDirectory}/${legacyInboxFile}`] ? legacyIdeasDirectory : '',
  ].filter(Boolean)

  if (!staleRootFolders.length) {
    return
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceFolderStorageKey)
  if (!rawValue) {
    return
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return
    }

    const normalizedFolders = [...new Set(parsed.map((item) => normalizeWorkspaceDocumentPath(String(item || '')).trim()).filter(Boolean))]
    const nextFolders = normalizedFolders.filter((folderPath) => !staleRootFolders.includes(folderPath))

    if (nextFolders.length !== normalizedFolders.length) {
      saveBrowserWorkspaceFolders(nextFolders)
    }
  } catch {
    // Ignore malformed legacy folder storage and let later calls rebuild it.
  }
}

function loadBrowserWorkspaceDocuments(): Record<string, BrowserWorkspaceRecord> {
  if (typeof window === 'undefined') {
    return {}
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceStorageKey)
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue)
      if (parsed && typeof parsed === 'object') {
        const records = parsed as Record<string, BrowserWorkspaceRecord>
        const migrated = migrateLegacyBrowserWorkspaceDocuments(records)
        if (migrated.changed) {
          cleanupLegacyBrowserSeedFolders(records)
          saveBrowserWorkspaceDocuments(migrated.records)
        }
        return migrated.records
      }
    } catch {
      // Recreate the browser workspace if the local cache is malformed.
    }
  }

  const now = new Date().toISOString()
  const seeded = createSeededBrowserWorkspaceDocuments(now)

  window.localStorage.setItem(browserWorkspaceStorageKey, JSON.stringify(seeded))
  return seeded
}

function saveBrowserWorkspaceDocuments(records: Record<string, BrowserWorkspaceRecord>) {
  window.localStorage.setItem(browserWorkspaceStorageKey, JSON.stringify(records))
}

function loadBrowserWorkspaceFolders(): string[] {
  if (typeof window === 'undefined') {
    return []
  }

  const rawValue = window.localStorage.getItem(browserWorkspaceFolderStorageKey)
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!Array.isArray(parsed)) {
      return []
    }
    return [...new Set(parsed.map((item) => normalizeWorkspaceDocumentPath(String(item || ''))).filter(Boolean))]
  } catch {
    return []
  }
}

function saveBrowserWorkspaceFolders(folders: string[]) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(
    browserWorkspaceFolderStorageKey,
    JSON.stringify([...new Set(folders.map((item) => normalizeWorkspaceDocumentPath(item)).filter(Boolean))]),
  )
}

function buildBrowserWorkspaceTree(records: Record<string, BrowserWorkspaceRecord>, folders: string[] = []): WorkspaceDocumentTreeItem[] {
  const rootItems: WorkspaceDocumentTreeItem[] = []

  function ensureFolder(children: WorkspaceDocumentTreeItem[], folderPath: string, name: string) {
    let folder = children.find((item) => item.type === 'folder' && item.path === folderPath)
    if (!folder) {
      folder = { type: 'folder', path: folderPath, name, children: [] }
      children.push(folder)
    }
    return folder
  }

  folders.forEach((folderPath) => {
    const parts = folderPath.split('/').filter(Boolean)
    let children = rootItems
    let currentPath = ''

    parts.forEach((part) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const folder = ensureFolder(children, currentPath, part)
      children = folder.children || []
    })
  })

  for (const [documentPath, record] of Object.entries(records)) {
    const parts = documentPath.split('/').filter(Boolean)
    let children = rootItems
    let currentPath = ''

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      if (index === parts.length - 1) {
        children.push({
          type: 'file',
          path: currentPath,
          name: part,
          format: inferWorkspaceDocumentFormat(currentPath),
          size: record.content.length,
          updated_at: record.updated_at,
        })
        return
      }

      const folder = ensureFolder(children, currentPath, part)
      children = folder.children || []
    })
  }

  function sortItems(items: WorkspaceDocumentTreeItem[]) {
    items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1
      }
      return left.name.localeCompare(right.name, getCurrentLocale())
    })
    items.forEach((item) => {
      if (item.children) {
        sortItems(item.children)
      }
    })
  }

  sortItems(rootItems)
  return rootItems
}

export async function listWorkspaceDocuments(): Promise<WorkspaceDocumentListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ListWorkspaceDocuments) {
    return bridge.ListWorkspaceDocuments()
  }

  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(loadBrowserWorkspaceDocuments(), loadBrowserWorkspaceFolders()),
  }
}

export async function readWorkspaceDocument(path: string): Promise<WorkspaceDocument> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.ReadWorkspaceDocument) {
    return bridge.ReadWorkspaceDocument({ path: normalizedPath })
  }

  const records = loadBrowserWorkspaceDocuments()
  const record = records[normalizedPath]
  if (!record) {
    throw new Error('document not found')
  }

  return {
    path: normalizedPath,
    name: normalizedPath.split('/').pop() || normalizedPath,
    content: record.content,
    format: inferWorkspaceDocumentFormat(normalizedPath),
    updated_at: record.updated_at,
    size: record.content.length,
  }
}

export function subscribeWorkspaceDocumentExternalChanges(
  handler: (change: WorkspaceDocumentExternalChange) => void,
): () => void {
  const bridge = getDesktopBridge()
  const eventName = bridge?.documentExternalChangeEvent
  if (!bridge?.EventsOn || !eventName) {
    return () => {}
  }

  return bridge.EventsOn(eventName, (payload: Partial<WorkspaceDocumentExternalChange>) => {
    const path = normalizeWorkspaceDocumentPath(String(payload?.path || ''))
    const eventType = payload?.eventType
    if (!path || (eventType !== 'add' && eventType !== 'change' && eventType !== 'unlink')) {
      return
    }
    handler({
      path,
      eventType,
      mtimeMs: typeof payload.mtimeMs === 'number' ? payload.mtimeMs : undefined,
    })
  }) || (() => {})
}

export async function statWorkspaceDocument(
  path: string,
): Promise<{ mtime_ms: number; size: number } | null> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.StatWorkspaceDocument) {
    return bridge.StatWorkspaceDocument({ path: normalizedPath })
  }
  return null
}

export async function writeWorkspaceDocument(path: string, content: string): Promise<WorkspaceDocument> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.WriteWorkspaceDocument) {
    return bridge.WriteWorkspaceDocument({ path: normalizedPath, content })
  }

  const records = loadBrowserWorkspaceDocuments()
  const updated_at = new Date().toISOString()
  records[normalizedPath] = { content, updated_at }
  saveBrowserWorkspaceDocuments(records)

  return {
    path: normalizedPath,
    name: normalizedPath.split('/').pop() || normalizedPath,
    content,
    format: inferWorkspaceDocumentFormat(normalizedPath),
    updated_at,
    size: content.length,
  }
}

export async function createWorkspaceDocument(request: WorkspaceDocumentCreateRequest = {}): Promise<WorkspaceDocument> {
  const bridge = getDesktopBridge()
  if (bridge?.CreateWorkspaceDocument) {
    return bridge.CreateWorkspaceDocument(request)
  }

  const records = loadBrowserWorkspaceDocuments()
  const folder = normalizeWorkspaceDocumentPath(request.folder || '')
  const format = request.format === 'data' ? 'data' : 'markdown'
  const title = String(request.title || 'Untitled document').trim() || 'Untitled document'
  const extension = format === 'data' ? '.kitable' : '.md'
  const filename = /\.(md|kitable)$/i.test(title) ? title.replace(/\.(md|kitable)$/i, extension) : `${title}${extension}`
  let documentPath = folder ? `${folder}/${filename}` : filename
  const stem = documentPath.replace(/\.(md|kitable)$/i, '')
  let index = 2

  while (records[documentPath]) {
    documentPath = `${stem} ${index}${extension}`
    index += 1
  }

  const content = format === 'data'
    ? JSON.stringify({
      version: 1,
      format: 'kition-data-document',
      title: documentPath.split('/').pop()?.replace(/\.kitable$/i, '') || title,
    }, null, 2)
    : ''

  return writeWorkspaceDocument(documentPath, content)
}

function isMissingDesktopHandlerError(error: unknown) {
  return String((error as any)?.message || error || '').includes('No handler registered')
}

function collectWorkspaceItemPaths(items: WorkspaceDocumentTreeItem[], target = new Set<string>()) {
  for (const item of items) {
    target.add(item.path)
    if (item.type === 'folder' && Array.isArray(item.children)) {
      collectWorkspaceItemPaths(item.children, target)
    }
  }
  return target
}

export async function createWorkspaceFolder(request: WorkspaceFolderCreateRequest = {}): Promise<WorkspaceFolderCreateResponse> {
  const parentFolder = normalizeWorkspaceDocumentPath(request.parent_folder || '')
  const folderName = normalizeWorkspaceDocumentPath(String(request.name || '').trim()).split('/').pop() || 'Untitled folder'

  const bridge = getDesktopBridge()
  if (bridge?.CreateWorkspaceFolder) {
    try {
      return await bridge.CreateWorkspaceFolder({
        parent_folder: parentFolder,
        name: folderName,
      })
    } catch (error) {
      if (!isMissingDesktopHandlerError(error) || !bridge.WriteWorkspaceDocument || !bridge.ListWorkspaceDocuments) {
        throw error
      }

      const workspace = await listWorkspaceDocuments()
      const existingPaths = collectWorkspaceItemPaths(workspace.items)
      let createdPath = parentFolder ? `${parentFolder}/${folderName}` : folderName
      let index = 2

      while (
        existingPaths.has(createdPath)
        || Array.from(existingPaths).some((path) => path.startsWith(`${createdPath}/`))
      ) {
        createdPath = parentFolder ? `${parentFolder}/${folderName} ${index}` : `${folderName} ${index}`
        index += 1
      }

      await writeWorkspaceDocument(`${createdPath}/.keep.md`, '')
      const nextWorkspace = await listWorkspaceDocuments()
      return {
        root_path: nextWorkspace.root_path,
        items: nextWorkspace.items,
        created_path: createdPath,
      }
    }
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  let createdPath = parentFolder ? `${parentFolder}/${folderName}` : folderName
  let index = 2

  while (
    folders.includes(createdPath)
    || Object.keys(records).some((path) => path === createdPath || path.startsWith(`${createdPath}/`))
  ) {
    createdPath = parentFolder ? `${parentFolder}/${folderName} ${index}` : `${folderName} ${index}`
    index += 1
  }

  saveBrowserWorkspaceFolders([...folders, createdPath])
  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(records, [...folders, createdPath]),
    created_path: createdPath,
  }
}

export async function moveWorkspaceDocument(request: WorkspaceDocumentMoveRequest): Promise<WorkspaceDocument> {
  const normalizedPath = normalizeWorkspaceDocumentPath(request.path)
  const sourceParent = getBrowserWorkspaceParentPath(normalizedPath)
  const targetFolder = request.target_folder === undefined
    ? sourceParent
    : normalizeWorkspaceDocumentPath(request.target_folder || '')
  const targetName = String(request.target_name || '').trim()
  const bridge = getDesktopBridge()
  if (bridge?.MoveWorkspaceDocument) {
    return bridge.MoveWorkspaceDocument({
      path: normalizedPath,
      target_folder: targetFolder,
      target_name: targetName,
    })
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  const record = records[normalizedPath]
  if (!record) {
    throw new Error('document not found')
  }

  const filename = normalizedPath.split('/').pop() || normalizedPath
  if (sourceParent === targetFolder && (!targetName || targetName === filename)) {
    return readWorkspaceDocument(normalizedPath)
  }

  const nextPath = pickUniqueBrowserWorkspaceDocumentPath(records, targetFolder, targetName || filename)
  records[nextPath] = {
    ...record,
    updated_at: new Date().toISOString(),
  }
  delete records[normalizedPath]

  const oldChildPrefix = sourceParent
    ? `${sourceParent}/${getBrowserWorkspaceStem(normalizedPath)}/`
    : `${getBrowserWorkspaceStem(normalizedPath)}/`
  const newChildPrefix = `${nextPath.replace(/\.(md|markdown|kitable)$/i, '')}/`

  for (const [path, childRecord] of Object.entries({ ...records })) {
    if (!path.startsWith(oldChildPrefix)) {
      continue
    }

    const movedChildPath = `${newChildPrefix}${path.slice(oldChildPrefix.length)}`
    records[movedChildPath] = childRecord
    delete records[path]
  }

  saveBrowserWorkspaceDocuments(records)
  saveBrowserWorkspaceFolders(
    folders.map((folderPath) => {
      if (folderPath === oldChildPrefix.slice(0, -1) || folderPath.startsWith(oldChildPrefix)) {
        return `${newChildPrefix.slice(0, -1)}${folderPath.slice(oldChildPrefix.length - 1)}`
      }
      return folderPath
    }),
  )
  return readWorkspaceDocument(nextPath)
}

export async function moveWorkspaceFolder(request: WorkspaceFolderMoveRequest): Promise<WorkspaceFolderMoveResponse> {
  const normalizedPath = normalizeWorkspaceDocumentPath(request.path)
  const sourceParent = getBrowserWorkspaceParentPath(normalizedPath)
  const sourceName = normalizedPath.split('/').pop() || normalizedPath
  const targetFolder = request.target_folder === undefined
    ? sourceParent
    : normalizeWorkspaceDocumentPath(request.target_folder || '')
  const targetName = String(request.target_name || '').trim() || sourceName
  const nextFolderPath = targetFolder ? `${targetFolder}/${targetName}` : targetName

  if (!normalizedPath || normalizedPath === nextFolderPath || nextFolderPath.startsWith(`${normalizedPath}/`)) {
    throw new Error('invalid target folder')
  }

  const bridge = getDesktopBridge()
  if (bridge?.MoveWorkspaceFolder) {
    return bridge.MoveWorkspaceFolder({
      path: normalizedPath,
      target_folder: targetFolder,
      target_name: targetName,
    })
  }

  const records = loadBrowserWorkspaceDocuments()
  const folders = loadBrowserWorkspaceFolders()
  const prefix = `${normalizedPath}/`
  const hasFolder = folders.includes(normalizedPath) || folders.some((folderPath) => folderPath.startsWith(prefix))
  const branchEntries = Object.entries(records).filter(([path]) => path.startsWith(prefix))
  if (!branchEntries.length && !hasFolder) {
    throw new Error('folder not found')
  }

  const finalFolderPath = (() => {
    let candidate = nextFolderPath
    let index = 2
    while (Object.keys(records).some((path) => path === candidate || path.startsWith(`${candidate}/`))) {
      candidate = targetFolder ? `${targetFolder}/${targetName} ${index}` : `${targetName} ${index}`
      index += 1
    }
    return candidate
  })()

  const nextRecords = { ...records }
  branchEntries.forEach(([path, record]) => {
    const movedPath = `${finalFolderPath}/${path.slice(prefix.length)}`
    nextRecords[movedPath] = {
      ...record,
      updated_at: new Date().toISOString(),
    }
    delete nextRecords[path]
  })
  saveBrowserWorkspaceDocuments(nextRecords)
  const nextFolders = folders.map((folderPath) => {
      if (folderPath === normalizedPath || folderPath.startsWith(prefix)) {
        return `${finalFolderPath}${folderPath.slice(normalizedPath.length)}`
      }
      return folderPath
    })
  saveBrowserWorkspaceFolders(nextFolders)

  return {
    root_path: 'browser-local-workspace',
    items: buildBrowserWorkspaceTree(nextRecords, nextFolders),
    moved_path: finalFolderPath,
  }
}

export async function deleteWorkspaceDocument(path: string): Promise<WorkspaceDocumentListResponse> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.DeleteWorkspaceDocument) {
    return bridge.DeleteWorkspaceDocument({ path: normalizedPath })
  }

  const records = loadBrowserWorkspaceDocuments()
  if (!records[normalizedPath]) {
    throw new Error('document not found')
  }

  delete records[normalizedPath]

  const childPrefix = `${normalizedPath.replace(/\.(md|markdown|kitable)$/i, '')}/`
  Object.keys(records).forEach((recordPath) => {
    if (recordPath.startsWith(childPrefix)) {
      delete records[recordPath]
    }
  })

  saveBrowserWorkspaceDocuments(records)
  return listWorkspaceDocuments()
}

export async function deleteWorkspaceFolder(path: string): Promise<WorkspaceDocumentListResponse> {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  if (!normalizedPath) {
    throw new Error('the workspace root cannot be deleted')
  }
  const bridge = getDesktopBridge()
  if (bridge?.DeleteWorkspaceFolder) {
    return bridge.DeleteWorkspaceFolder({ path: normalizedPath })
  }

  const childPrefix = `${normalizedPath}/`
  const records = loadBrowserWorkspaceDocuments()
  Object.keys(records).forEach((recordPath) => {
    if (recordPath === normalizedPath || recordPath.startsWith(childPrefix)) {
      delete records[recordPath]
    }
  })
  saveBrowserWorkspaceDocuments(records)

  const folders = loadBrowserWorkspaceFolders()
  saveBrowserWorkspaceFolders(
    folders.filter((folderPath) => folderPath !== normalizedPath && !folderPath.startsWith(childPrefix)),
  )

  return listWorkspaceDocuments()
}

export async function openWorkspaceFile(path: string) {
  const normalizedPath = normalizeWorkspaceDocumentPath(path)
  const bridge = getDesktopBridge()
  if (bridge?.OpenWorkspaceFile) {
    return bridge.OpenWorkspaceFile({ path: normalizedPath })
  }
  throw new Error('desktop file opening is unavailable')
}

export async function importWorkspaceFile(request: WorkspaceFileImportRequest) {
  const bridge = getDesktopBridge()
  if (!bridge?.ImportWorkspaceFile) {
    throw new Error('desktop file import is unavailable')
  }
  const payload: WorkspaceFileImportRequest = {
    ...request,
    folder: request.folder ? normalizeWorkspaceDocumentPath(request.folder) : '',
  }
  const response = await bridge.ImportWorkspaceFile(payload)
  if (response?.imported_path) {
    response.imported_path = normalizeWorkspaceDocumentPath(response.imported_path)
  }
  return response
}

export async function chooseFilesToImport(): Promise<WorkspaceFileChooseResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseFilesToImport) {
    return { canceled: true, paths: [] }
  }
  return bridge.ChooseFilesToImport()
}

function extensionFromMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    default:
      return '.png'
  }
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  return uint8ArrayToBase64(new Uint8Array(buffer))
}

async function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('failed to read image blob'))
    reader.readAsDataURL(blob)
  })
}

export async function saveWorkspaceAssetFromBlobURL(options: {
  documentPath?: string
  blobURL: string
  index?: number
}): Promise<WorkspaceAsset> {
  const response = await fetch(options.blobURL)
  if (!response.ok) {
    throw new Error(`image blob read failed: ${response.status}`)
  }

  const blob = await response.blob()
  const mimeType = blob.type || 'image/png'
  const bridge = getDesktopBridge()

  if (bridge?.SaveWorkspaceAsset) {
    return bridge.SaveWorkspaceAsset({
      document_path: options.documentPath,
      filename: `image-${options.index || 1}${extensionFromMimeType(mimeType)}`,
      mime_type: mimeType,
      base64_content: await blobToBase64(blob),
    })
  }

  const dataURL = await blobToDataURL(blob)
  return {
    path: dataURL,
    url: dataURL,
    mime_type: mimeType,
  }
}

export async function importWorkspaceImageFromBlobURL(options: {
  folder?: string
  blobURL: string
  index?: number
}): Promise<{ importedPath: string; relativePath: string }> {
  const response = await fetch(options.blobURL)
  if (!response.ok) {
    throw new Error(`image blob read failed: ${response.status}`)
  }

  const blob = await response.blob()
  const mimeType = blob.type || 'image/png'
  const base64 = await blobToBase64(blob)
  const stamp = `${Date.now().toString(36)}-${(options.index || 1).toString(36)}`
  const filename = `pasted-${stamp}${extensionFromMimeType(mimeType)}`

  const result = await importWorkspaceFile({
    folder: options.folder || '',
    filename,
    base64_content: base64,
  })
  const importedPath = String(result?.imported_path || '')
  const folder = String(options.folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normalizedImported = importedPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const relativePath = folder && normalizedImported.startsWith(`${folder}/`)
    ? normalizedImported.slice(folder.length + 1)
    : normalizedImported
  return { importedPath: normalizedImported, relativePath }
}

export async function revealWorkspaceFolder(path?: string) {
  const bridge = getDesktopBridge()
  if (bridge?.RevealWorkspaceFolder) {
    return bridge.RevealWorkspaceFolder(path ? { path: normalizeWorkspaceDocumentPath(path) } : undefined)
  }
  return ''
}

export async function chooseWorkspaceFolder() {
  const bridge = getDesktopBridge()
  if (bridge?.ChooseWorkspaceFolder) {
    return bridge.ChooseWorkspaceFolder()
  }
  return null
}

export async function setWorkspaceFolder(path: string) {
  const bridge = getDesktopBridge()
  if (bridge?.SetWorkspaceFolder) {
    return bridge.SetWorkspaceFolder({ path })
  }

  throw new Error('desktop workspace switching is unavailable')
}

export async function listVaults(): Promise<VaultListResponse> {
  const bridge = getDesktopBridge()
  if (bridge?.ListVaults) {
    return bridge.ListVaults()
  }
  const now = new Date().toISOString()
  return {
    vaults: [{
      path: 'browser-local-workspace',
      name: 'Browser local workspace',
      added_at: now,
      last_opened_at: now,
    }],
    active_vault_path: 'browser-local-workspace',
  }
}

export async function addVault(request: VaultAddRequest): Promise<VaultMutationResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.AddVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.AddVault(request)
}

export async function removeVault(path: string): Promise<VaultListResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.RemoveVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.RemoveVault({ path })
}

export async function renameVault(path: string, name: string): Promise<VaultMutationResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.RenameVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.RenameVault({ path, name })
}

export async function setActiveVault(path: string): Promise<SetActiveVaultResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.SetActiveVault) {
    throw new Error('desktop vault registry is unavailable')
  }
  return bridge.SetActiveVault({ path })
}

export async function chooseDirectory(title?: string): Promise<ChooseDirectoryResponse> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseDirectory) {
    return { canceled: true, path: '' }
  }
  return bridge.ChooseDirectory({ title })
}

export async function chooseAgentAnalysisDirectory(suggestedPath = ''): Promise<AgentLocalSource | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.ChooseAgentAnalysisDirectory) {
    throw new Error('local analysis folders are available in the desktop app')
  }
  return bridge.ChooseAgentAnalysisDirectory({ suggested_path: suggestedPath })
}

export async function saveTextFile(options: { dialogTitle: string; defaultFilename: string; content: string }) {
  const bridge = getDesktopBridge()
  if (!bridge?.SaveTextFile) {
    throw new Error('desktop save is unavailable')
  }

  return bridge.SaveTextFile(options.dialogTitle, options.defaultFilename, options.content)
}

export async function saveBinaryFile(options: { dialogTitle: string; defaultFilename: string; bytes: Uint8Array }) {
  const bridge = getDesktopBridge()
  if (!bridge?.SaveBinaryFile) {
    throw new Error('desktop save is unavailable')
  }

  return bridge.SaveBinaryFile({
    dialog_title: options.dialogTitle,
    default_filename: options.defaultFilename,
    base64_content: uint8ArrayToBase64(options.bytes),
  })
}

export async function savePdfFile(options: {
  dialogTitle: string
  defaultFilename: string
  html: string
  pageFormat?: string
  documentPath?: string
  landscape?: boolean
  marginsType?: 0 | 1 | 2
  scaleFactor?: number
}) {
  const bridge = getDesktopBridge()
  if (!bridge?.SavePdfFile) {
    throw new Error('desktop PDF export is unavailable')
  }

  const request: SavePdfFileRequest = {
    dialog_title: options.dialogTitle,
    default_filename: options.defaultFilename,
    html: options.html,
    page_format: options.pageFormat,
  }
  if (options.documentPath) {
    request.document_path = options.documentPath
  }
  if (typeof options.landscape === 'boolean') {
    request.landscape = options.landscape
  }
  if (options.marginsType === 0 || options.marginsType === 1 || options.marginsType === 2) {
    request.margins_type = options.marginsType
  }
  if (typeof options.scaleFactor === 'number' && Number.isFinite(options.scaleFactor)) {
    request.scale_factor = options.scaleFactor
  }

  return bridge.SavePdfFile(request)
}

export async function copyDocumentHtmlToClipboard(options: {
  html: string
  text: string
  documentPath?: string
}) {
  const bridge = getDesktopBridge()
  if (bridge?.CopyDocumentHtml) {
    const request: CopyDocumentHtmlRequest = {
      html: options.html,
      text: options.text,
    }
    if (options.documentPath) {
      request.document_path = options.documentPath
    }
    return bridge.CopyDocumentHtml(request)
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('rich clipboard is unavailable')
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([options.html], { type: 'text/html' }),
      'text/plain': new Blob([options.text], { type: 'text/plain' }),
    }),
  ])
  return true
}

async function imageBlobToPng(blob: Blob) {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('image canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('image conversion failed'))
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

export async function copyImageToClipboard(url: string) {
  const source = String(url || '').trim()
  if (!source) throw new Error('image URL is required')

  const bridge = getDesktopBridge()
  if (bridge?.CopyImage) {
    try {
      return await bridge.CopyImage({ url: source })
    } catch {
      const response = await fetch(source)
      if (!response.ok) throw new Error(`image download failed: ${response.status}`)
      const png = await imageBlobToPng(await response.blob())
      return bridge.CopyImage({ url: await blobToDataURL(png) })
    }
  }

  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('image clipboard is unavailable')
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error(`image download failed: ${response.status}`)
  const png = await imageBlobToPng(await response.blob())
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  return true
}

export async function saveRemoteFile(url: string, defaultFilename: string, dialogTitle: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`download failed: ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  return saveBinaryFile({
    dialogTitle,
    defaultFilename,
    bytes: new Uint8Array(buffer),
  })
}

export async function setSecureValue(key: string, value: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.StoreSecureValue) {
    localStorage.setItem(key, value)
    return
  }
  await bridge.StoreSecureValue(key, value)
}

export async function getSecureValue(key: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.ReadSecureValue) {
    return localStorage.getItem(key) || ''
  }
  return bridge.ReadSecureValue(key)
}

export async function deleteSecureValue(key: string) {
  const bridge = getDesktopBridge()
  if (!bridge?.DeleteSecureValue) {
    localStorage.removeItem(key)
    return
  }
  await bridge.DeleteSecureValue(key)
}

export function registerDesktopMenuHandler(handler: (payload: { action?: string; profileId?: string }) => void) {
  const bridge = getDesktopBridge()
  if (!bridge?.EventsOn) {
    return
  }

  bridge.EventsOn('desktop:menu', (payload: { action?: string; profileId?: string }) => {
    if (payload?.action) {
      handler(payload)
    }
  })
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


function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
