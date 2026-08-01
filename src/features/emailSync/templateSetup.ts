import { openDataDocumentByPath } from '@/api/dataDocuments'
import { ONBOARDING_EMAIL_INBOX_SYNC_PATH } from '@/features/onboarding/onboardingManifest'

export const EMAIL_INBOX_SYNC_TEMPLATE_ID = 'email-inbox-sync'

export async function isEmailInboxSyncTemplateTable(tablePath: string, rootPath?: string) {
  const normalizedPath = String(tablePath || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (normalizedPath === ONBOARDING_EMAIL_INBOX_SYNC_PATH) {
    return true
  }
  try {
    const document = await openDataDocumentByPath({
      path: tablePath,
      ...(rootPath ? { workspace_root: rootPath } : {}),
    })
    return String(document.meta?.template_id || '') === EMAIL_INBOX_SYNC_TEMPLATE_ID
  } catch {
    return false
  }
}
