import { beforeEach, describe, expect, it, vi } from 'vitest'

import request from './request'
import {
  getWorkspaceStorageStatus,
  inventoryWorkspaceStorage,
  migrateWorkspaceStorage,
  verifyWorkspaceStorage,
} from './workspaceStorage'

vi.mock('./request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

const status = {
  schema_version: 1 as const,
  storage_version: 1,
  workspace_id: '0123456789abcdef',
  capability: 'workspace_portable_storage_v1' as const,
  migration_state: 'ready' as const,
  portable: true,
  summary: {
    documents: 1,
    kitables: 1,
    assets: 2,
    workflows: 1,
    agent_sessions: 1,
    sync_states: 0,
    total_bytes: 4096,
  },
  issues: [],
}

describe('workspace storage API', () => {
  beforeEach(() => {
    vi.mocked(request.get).mockReset()
    vi.mocked(request.post).mockReset()
  })

  it('loads status and inventory from the portable storage endpoints', async () => {
    vi.mocked(request.get)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ status, items: [] })

    await expect(getWorkspaceStorageStatus()).resolves.toEqual(status)
    await expect(inventoryWorkspaceStorage()).resolves.toEqual({ status, items: [] })
    expect(request.get).toHaveBeenNthCalledWith(1, '/v1/workspace/storage')
    expect(request.get).toHaveBeenNthCalledWith(2, '/v1/workspace/storage/inventory')
  })

  it('verifies storage without mutating the workspace', async () => {
    const result = { verified_at: '2026-08-01T10:00:00Z', valid: true, status }
    vi.mocked(request.post).mockResolvedValue(result)

    await expect(verifyWorkspaceStorage()).resolves.toEqual(result)
    expect(request.post).toHaveBeenCalledWith('/v1/workspace/storage/verify', {})
  })

  it('supports a dry-run migration before runtime state changes', async () => {
    const result = {
      dry_run: true,
      migrated_assets: 2,
      updated_references: 3,
      migrated_state_records: 4,
      status,
    }
    vi.mocked(request.post).mockResolvedValue({ data: result })

    await expect(migrateWorkspaceStorage({ dry_run: true })).resolves.toEqual(result)
    expect(request.post).toHaveBeenCalledWith('/v1/workspace/storage/migrate', {
      dry_run: true,
    })
  })
})
