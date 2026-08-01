import request from './request'
import type {
  WorkspaceStorageInventory,
  WorkspaceStorageMigrationInput,
  WorkspaceStorageMigrationResult,
  WorkspaceStorageStatus,
  WorkspaceStorageVerifyResult,
} from '@/types/workspaceStorage'

function unwrapResponseData<T>(response: T | { data?: T }) {
  return (response as { data?: T })?.data ?? (response as T)
}

export function getWorkspaceStorageStatus() {
  return request
    .get<WorkspaceStorageStatus | { data?: WorkspaceStorageStatus }>('/v1/workspace/storage')
    .then(unwrapResponseData<WorkspaceStorageStatus>)
}

export function inventoryWorkspaceStorage() {
  return request
    .get<WorkspaceStorageInventory | { data?: WorkspaceStorageInventory }>('/v1/workspace/storage/inventory')
    .then(unwrapResponseData<WorkspaceStorageInventory>)
}

export function verifyWorkspaceStorage() {
  return request
    .post<WorkspaceStorageVerifyResult | { data?: WorkspaceStorageVerifyResult }>(
      '/v1/workspace/storage/verify',
      {},
    )
    .then(unwrapResponseData<WorkspaceStorageVerifyResult>)
}

export function migrateWorkspaceStorage(input: WorkspaceStorageMigrationInput = {}) {
  return request
    .post<WorkspaceStorageMigrationResult | { data?: WorkspaceStorageMigrationResult }>(
      '/v1/workspace/storage/migrate',
      input,
    )
    .then(unwrapResponseData<WorkspaceStorageMigrationResult>)
}
