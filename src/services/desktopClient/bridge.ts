/**
 * The desktop bridge as the renderer sees it: the `window.kitionDesktop` surface and every payload type it exchanges.
 */
import type { KitCheckpoint } from '@kition/sdk/protocol'
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
  SaveBinaryFile?: (request: SaveFileRequest) => Promise<string>
  SavePdfFile?: (request: SavePdfFileRequest) => Promise<string>
  CopyImage?: (request: { url: string }) => Promise<boolean>
  /** Prints a PDF with the system's print panel; answers whether the person printed. */
  PrintPdf?: (bytes: Uint8Array, title: string) => Promise<boolean>
  SubmitFeedback?: (request: FeedbackReportSubmissionRequest) => Promise<FeedbackReportSubmissionResponse>
  ListWorkspaceDocuments?: () => Promise<WorkspaceDocumentListResponse>
  ReadWorkspaceImage?: (request: { path: string; expected_root: string }) => Promise<DesktopClipboardImage>
  ReadWorkspaceDocument?: (request: WorkspaceDocumentPathRequest) => Promise<WorkspaceDocument>
  StatWorkspaceDocument?: (request: { path: string }) => Promise<{ mtime_ms: number; size: number } | null>
  WriteWorkspaceDocument?: (request: WorkspaceDocumentWriteRequest) => Promise<WorkspaceDocument>
  CreateWorkspaceDocument?: (request: WorkspaceDocumentCreateRequest) => Promise<WorkspaceDocument>
  ReadDocumentStore?: (request: DocumentStoreRequest) => Promise<DocumentStorePayload | null>
  WriteDocumentStore?: (request: DocumentStoreWriteRequest) => Promise<DocumentStoreWritten>
  DeleteDocumentStore?: (request: DocumentStoreRequest) => Promise<void | null>
  ReadDocumentIndex?: (request: DocumentIndexRequest) => Promise<DocumentIndexPayload>
  WriteDocumentIndex?: (request: DocumentIndexWriteRequest) => Promise<{ version: string }>
  ReadDocumentHistory?: (request: DocumentStoreRequest) => Promise<{ checkpoints: KitCheckpoint[] }>
  /** A document's checkpoints as kits see them (Kit UI protocol section 7m), newest first. */
  ListKitCheckpoints?: (request: DocumentStoreRequest & KitCheckpointQuery) => Promise<{ checkpoints: KitCheckpoint[]; more: boolean }>
  FindKitCheckpoint?: (request: DocumentStoreRequest & { id: string }) => Promise<KitCheckpoint | null>
  UpdateKitCheckpoint?: (request: DocumentStoreRequest & { id: string; label?: string; description?: string }) => Promise<{ checkpoint: KitCheckpoint }>
  DeleteKitCheckpoint?: (request: DocumentStoreRequest & { id: string }) => Promise<void | null>
  ReadKitCheckpoint?: (request: DocumentStoreRequest & { id: string }) => Promise<{ checkpoint: KitCheckpoint; snapshot_base64: string; blobs_base64: string }>
  /** A document's view state, kept in the app's own data (Kit UI protocol section 7n). */
  ReadViewState?: (request: DocumentStoreRequest) => Promise<{ state: Record<string, unknown> | null; bytes_base64?: string }>
  WriteViewState?: (request: DocumentStoreRequest & { state: Record<string, unknown> | null; bytes_base64?: string }) => Promise<void | null>
  DocumentStoreStatus?: () => Promise<DocumentStoreStatus>
  /** The event the shell sends with a new `DocumentStoreStatus` when this window takes the store lock over or loses it. */
  documentStoreAccessEvent?: string
  CreateWorkspaceFolder?: (request: WorkspaceFolderCreateRequest) => Promise<WorkspaceFolderCreateResponse>
  MoveWorkspaceDocument?: (request: WorkspaceDocumentMoveRequest) => Promise<WorkspaceDocument>
  MoveWorkspaceFolder?: (request: WorkspaceFolderMoveRequest) => Promise<WorkspaceFolderMoveResponse>
  DeleteWorkspaceDocument?: (request: WorkspaceDocumentPathRequest) => Promise<WorkspaceDocumentListResponse>
  DeleteWorkspaceFolder?: (request: WorkspaceFolderRequest) => Promise<WorkspaceDocumentListResponse>
  OpenWorkspaceFile?: (request: WorkspaceDocumentPathRequest) => Promise<string>
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

/** The kinds of file Kition knows itself. `binary` is a file neither Kition nor a kit of this build knows. */
export type HostDocumentFormat =
  | 'markdown'
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

/** A file only a kit knows: the kit's name (its id without `kit.`), from the kit's manifest. */
export type KitDocumentFormat = string & {}

export type WorkspaceDocumentFormat = HostDocumentFormat | KitDocumentFormat

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
  /** The write is refused when the file exists. */
  expected_missing?: boolean
  path: string
  content: string
}

/**
 * What the store keeps about a replica a kit editor keeps for its file (Kit UI protocol capability `replica`): the
 * stamp of the file it was saved with.
 */
export type KitReplicaMeta = {
  docId: string
  kit: string
  path: string
  fileStamp: string
}

export type DocumentStoreRequest = {
  expected_root?: string
  doc_id: string
}

/** A stored replica: the last written snapshot (opaque bytes), the version it holds (base64), and its blob bundle. */
export type DocumentStorePayload = {
  meta: KitReplicaMeta
  snapshot_base64: string
  version: string
  blobs_base64?: string
}

/** What the renderer asks to record with a replica write (Kit UI protocol section 7m). */
export type DocumentCheckpointInput = {
  /** `kit`, `save`, `agent`. */
  origin: string
  author?: string
  /** At most 200 characters; a label at the newest checkpoint's version names that checkpoint. */
  label?: string
  /** At most 2000 characters. */
  description?: string
  time?: number
}

/** One page of a document's checkpoints: newest first, at most `limit` (200), only labelled ones, only older than `before`. */
export type KitCheckpointQuery = {
  labelled?: boolean
  before?: string
  limit?: number
}

/** A replica write: the snapshot, the version it holds (base64 of the kit's bytes), its blobs, and the checkpoint asked. */
export type DocumentStoreWriteRequest = DocumentStoreRequest & {
  meta: KitReplicaMeta
  snapshot_base64: string
  version: string
  blobs_base64?: string
  checkpoint?: DocumentCheckpointInput
}

/** The stored version, and the checkpoint recorded with the write (or the newest one, at its version), as a kit sees it. */
export type DocumentStoreWritten = {
  version: string
  checkpoint?: KitCheckpoint
}

/**
 * Whether this window writes the workspace's document store: one Kition does (the one holding its lock file); any
 * other opens it read-only. `holder` names the one that does.
 */
export type DocumentStoreStatus = {
  writable: boolean
  holder: { host: string; pid: number; started: number; heartbeat: number; sameHost: boolean } | null
}

export type DocumentIndexRequest = {
  expected_root?: string
}

/** The `.kition/docs/index.json` mapping of workspace paths to document ids; `version` is `null` before the first write. */
export type DocumentIndexPayload = {
  entries: Record<string, string>
  version: string | null
}

export type DocumentIndexWriteRequest = DocumentIndexRequest & {
  entries: Record<string, string>
  expected_version: string | null
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
