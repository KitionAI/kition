import type { DataAttachment } from '@/types/dataDocument'
import { PORTABLE_WORKSPACE_STORAGE_CAPABILITY } from '@/types/workspaceStorage'

export type PersistedAttachmentStorageKind =
  | 'portable'
  | 'legacy_upload'
  | 'workspace_url'
  | 'inline'
  | 'external'
  | 'invalid'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function hasPortableWorkspaceStorageCapability(capabilities?: readonly string[]) {
  return Boolean(capabilities?.includes(PORTABLE_WORKSPACE_STORAGE_CAPABILITY))
}

export function isPortableWorkspacePath(value: unknown) {
  const path = String(value || '').trim().replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /^[a-z]:\//i.test(path)) {
    return false
  }
  return !path.split('/').some((segment) => segment === '..')
}

export function isPortableWorkspaceAttachment(attachment: DataAttachment) {
  return Boolean(
    attachment
    && SHA256_PATTERN.test(String(attachment.sha256 || ''))
    && isPortableWorkspacePath(attachment.workspacePath),
  )
}

export function classifyPersistedAttachmentStorage(
  attachment: DataAttachment | null | undefined,
): PersistedAttachmentStorageKind {
  if (!attachment) return 'invalid'
  if (isPortableWorkspaceAttachment(attachment)) return 'portable'

  const rawURL = String(attachment.url || '').trim()
  if (!rawURL) return 'invalid'
  if (/^\/?uploads\//i.test(rawURL)) return 'legacy_upload'
  if (/^https?:\/\//i.test(rawURL)) {
    try {
      return /^\/uploads\//i.test(new URL(rawURL).pathname) ? 'legacy_upload' : 'external'
    } catch {
      return 'external'
    }
  }
  if (/^(data:|blob:)/i.test(rawURL)) return 'inline'
  if (/^(kition-workspace:|\/?workspace-files\/)/i.test(rawURL)) return 'workspace_url'
  if (/^file:/i.test(rawURL) || rawURL.startsWith('/')) return 'external'
  return isPortableWorkspacePath(rawURL) ? 'workspace_url' : 'invalid'
}
