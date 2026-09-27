/**
 * Portable workspace storage types. Contract:
 * contracts/runtime/workspace-storage.schema.json. Shapes are the generated
 * contract types; only the capability constant and derived aliases live here.
 */
import type {
  WorkspaceStorageAssetReference,
  WorkspaceStorageInventory,
  WorkspaceStorageInventoryItem,
  WorkspaceStorageIssue,
  WorkspaceStorageMigrationInput,
  WorkspaceStorageMigrationResult,
  WorkspaceStorageStatus,
  WorkspaceStorageSummary,
  WorkspaceStorageVerifyResult,
} from '@/api/generated'

export const PORTABLE_WORKSPACE_STORAGE_CAPABILITY = 'workspace_portable_storage_v1' as const

export type {
  WorkspaceStorageInventory,
  WorkspaceStorageInventoryItem,
  WorkspaceStorageIssue,
  WorkspaceStorageMigrationInput,
  WorkspaceStorageMigrationResult,
  WorkspaceStorageStatus,
  WorkspaceStorageSummary,
  WorkspaceStorageVerifyResult,
}
export type WorkspaceStorageMigrationState = WorkspaceStorageStatus['migration_state']
export type WorkspaceStorageIssueCode = WorkspaceStorageIssue['code']
export type PortableWorkspaceAssetReference = WorkspaceStorageAssetReference
