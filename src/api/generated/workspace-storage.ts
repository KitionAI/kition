/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/workspace-storage.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type WorkspaceStoragePortablePath = string

export type WorkspaceStorageAssetReference = {
  asset_id: string
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
  workspace_path: WorkspaceStoragePortablePath
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

export type WorkspaceStorageIssue = {
  code: "legacy_upload_url" | "absolute_path" | "missing_asset" | "hash_mismatch" | "external_workspace_state" | "migration_incomplete" | "orphan_asset" | "invalid_manifest" | "secret_material_present"
  severity: "info" | "warning" | "error"
  message: string
  workspace_path?: WorkspaceStoragePortablePath
  reference?: string
}

export type WorkspaceStorageStatus = {
  schema_version: 1
  storage_version: number
  workspace_id: string
  capability: "workspace_portable_storage_v1"
  migration_state: "ready" | "required" | "running" | "failed"
  portable: boolean
  summary: WorkspaceStorageSummary
  issues: WorkspaceStorageIssue[]
}

export type WorkspaceStorageInventoryItem = {
  kind: "document" | "kitable" | "asset" | "workflow" | "workflow_run" | "agent_session" | "agent_message" | "agent_event" | "sync_state" | "workspace_metadata"
  workspace_path: WorkspaceStoragePortablePath
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
  /**
   * @default false
   */
  dry_run?: boolean
  /**
   * @default true
   */
  include_workspace_state?: boolean
}

export type WorkspaceStorageMigrationResult = {
  dry_run: boolean
  migrated_assets: number
  updated_references: number
  migrated_state_records: number
  status: WorkspaceStorageStatus
}

export type WorkspaceStorageContract = WorkspaceStorageStatus
