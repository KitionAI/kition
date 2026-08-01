import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  classifyPersistedAttachmentStorage,
  hasPortableWorkspaceStorageCapability,
  isPortableWorkspaceAttachment,
  isPortableWorkspacePath,
} from './workspaceStorage'
import { PORTABLE_WORKSPACE_STORAGE_CAPABILITY } from '@/types/workspaceStorage'

describe('portable workspace storage boundary', () => {
  it('keeps the client capability in lockstep with the public contract', () => {
    const schema = JSON.parse(
      readFileSync(resolve('contracts/runtime/workspace-storage.schema.json'), 'utf8'),
    )

    expect(schema.$defs.status.properties.capability.const).toBe(
      PORTABLE_WORKSPACE_STORAGE_CAPABILITY,
    )
    expect(schema.$defs.assetReference.required).toContain('workspace_path')
    expect(schema['x-storage-boundary'].device_local).toContain('credentials')
  })

  it('requires relative workspace paths without parent traversal', () => {
    expect(isPortableWorkspacePath('.kition/assets/sha256/ab/file.png')).toBe(true)
    expect(isPortableWorkspacePath('Projects/Brief.md')).toBe(true)
    expect(isPortableWorkspacePath('/tmp/file.png')).toBe(false)
    expect(isPortableWorkspacePath('../outside/file.png')).toBe(false)
    expect(isPortableWorkspacePath('Projects/../../outside/file.png')).toBe(false)
    expect(isPortableWorkspacePath('C:\\Users\\alice\\file.png')).toBe(false)
  })

  it('recognizes content-addressed portable attachments', () => {
    const attachment = {
      name: 'receipt.png',
      url: '/workspace-files/.kition/assets/sha256/ab/asset.png',
      sha256: 'a'.repeat(64),
      workspacePath: '.kition/assets/sha256/ab/asset.png',
    }

    expect(isPortableWorkspaceAttachment(attachment)).toBe(true)
    expect(classifyPersistedAttachmentStorage(attachment)).toBe('portable')
  })

  it('detects legacy uploads and non-portable references', () => {
    expect(classifyPersistedAttachmentStorage({ name: 'a.png', url: '/uploads/a.png' }))
      .toBe('legacy_upload')
    expect(classifyPersistedAttachmentStorage({
      name: 'a.png',
      url: 'http://127.0.0.1:18101/uploads/a.png',
    })).toBe('legacy_upload')
    expect(classifyPersistedAttachmentStorage({ name: 'a.png', url: 'blob:test' }))
      .toBe('inline')
    expect(classifyPersistedAttachmentStorage({ name: 'a.png', url: 'https://example.com/a.png' }))
      .toBe('external')
  })

  it('gates portable behavior behind an explicit runtime capability', () => {
    expect(hasPortableWorkspaceStorageCapability()).toBe(false)
    expect(hasPortableWorkspaceStorageCapability(['template_assets'])).toBe(false)
    expect(hasPortableWorkspaceStorageCapability([
      'template_assets',
      PORTABLE_WORKSPACE_STORAGE_CAPABILITY,
    ])).toBe(true)
  })
})
