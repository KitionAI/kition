export const PORTABLE_WORKSPACE_STORAGE_CAPABILITY = 'workspace_portable_storage_v1' as const

export type WorkspaceStorageMigrationState = 'ready' | 'required' | 'running' | 'failed'

export type WorkspaceStorageIssueCode =
  | 'legacy_upload_url'
  | 'absolute_path'
  | 'missing_asset'
  | 'hash_mismatch'
  | 'external_workspace_state'
  | 'migration_incomplete'
  | 'orphan_asset'
  | 'invalid_manifest'
  | 'secret_material_present'

export type WorkspaceStorageIssue = {
  code: WorkspaceStorageIssueCode
  severity: 'info' | 'warning' | 'error'
  message: string
  workspace_path?: string
  reference?: string
}

export type WorkspaceStorageSummary = {
  documents: number
  kitables: number
  assets: number
  workflows: number
  agent_sessions: number
  sync_states: number
  total_bytes: number
}

export type WorkspaceStorageStatus = {
  schema_version: 1
  storage_version: number
  workspace_id: string
  capability: typeof PORTABLE_WORKSPACE_STORAGE_CAPABILITY
  migration_state: WorkspaceStorageMigrationState
  portable: boolean
  summary: WorkspaceStorageSummary
  issues: WorkspaceStorageIssue[]
}

export type WorkspaceStorageInventoryItem = {
  kind:
    | 'document'
    | 'kitable'
    | 'asset'
    | 'workflow'
    | 'workflow_run'
    | 'agent_session'
    | 'agent_message'
    | 'agent_event'
    | 'sync_state'
    | 'workspace_metadata'
  workspace_path: string
  size_bytes: number
  sha256?: string
}

export type WorkspaceStorageInventory = {
  status: WorkspaceStorageStatus
  items: WorkspaceStorageInventoryItem[]
}

export type WorkspaceStorageVerifyResult = {
  verified_at: string
  valid: boolean
  status: WorkspaceStorageStatus
}

export type WorkspaceStorageMigrationInput = {
  dry_run?: boolean
  include_workspace_state?: boolean
}

export type WorkspaceStorageMigrationResult = {
  dry_run: boolean
  migrated_assets: number
  updated_references: number
  migrated_state_records: number
  status: WorkspaceStorageStatus
}

export type PortableWorkspaceAssetReference = {
  asset_id: string
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
  workspace_path: string
}
