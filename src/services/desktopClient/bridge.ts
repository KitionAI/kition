/**
 * The desktop bridge as the renderer sees it: the `window.kitionDesktop` surface and every payload type it exchanges.
 */
import type { AgentLocalSource } from '@/types/agentLocalSource'

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
  ReadClipboardImage?: () => Promise<DesktopClipboardImage | null>
  ReadRemoteImage?: (url: string) => Promise<DesktopClipboardImage>
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
  | 'photo'
  | 'film'
  | 'vector'
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
