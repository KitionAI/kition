/**
 * The preload bridge as the renderer sees it: the `window.kitionDesktop` surface and every payload type it exchanges.
 */
import type { AgentLocalSource } from '@/types/agentLocalSource'

type KitionDesktopBridge = {
  shell?: string
  backendOrigin?: string
  DesktopInfo?: () => Promise<DesktopInfo>
  ReadBundledAsset?: (request: { path: string }) => Promise<{
    base64_content: string
    size_bytes: number
  }>
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
  ReadClipboardImage?: () => Promise<DesktopClipboardImage | null>
  SubmitFeedback?: (request: FeedbackReportSubmissionRequest) => Promise<FeedbackReportSubmissionResponse>
  ListWorkspaceDocuments?: () => Promise<WorkspaceDocumentListResponse>
  ReadWorkspaceImage?: (request: { path: string; expected_root: string }) => Promise<DesktopClipboardImage>
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
  OpenWorkspaceWindow?: (request: VaultPathRequest) => Promise<OpenWorkspaceWindowResponse>
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
  | 'board'
  | 'design'

export type WorkspaceDocumentPathRequest = {
  expected_root?: string
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

export type OpenWorkspaceWindowResponse = {
  opened: boolean
}

export type AgentAnalysisDirectoryRequest = {
  suggested_path?: string
}

export type WorkspaceDocumentWriteRequest = {
  expected_root?: string
  expected_content?: string | null
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

export type DesktopClipboardImage = {
  mime_type: string
  base64_content: string
}

export type WorkspaceFileImportRequest = {
  expected_root?: string
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

export type SavePdfFileRequest = {
  dialog_title: string
  default_filename: string
  html: string
  page_format?: string
  document_path?: string
  landscape?: boolean
  margins_type?: 0 | 1 | 2
  scale_factor?: number
  /** Custom page size in CSS pixels; wins over page_format. */
  page_width_px?: number
  page_height_px?: number
}

export type CopyDocumentHtmlRequest = {
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

export function getDesktopBridge(): KitionDesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.kitionDesktop : undefined
}
