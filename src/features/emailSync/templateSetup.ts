import { listTableFiles } from '@/api/kitTables'
import { ONBOARDING_EMAIL_INBOX_SYNC_PATH } from '@/features/onboarding/onboardingManifest'

export const EMAIL_INBOX_SYNC_TEMPLATE_ID = 'email-inbox-sync'

/** Whether a table file is the email inbox template: the onboarding file, or one whose tables say so. */
export async function isEmailInboxSyncTemplateTable(tablePath: string) {
  const normalizedPath = String(tablePath || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (normalizedPath === ONBOARDING_EMAIL_INBOX_SYNC_PATH) {
    return true
  }
  try {
    const { files } = await listTableFiles()
    const file = files.find((candidate) => candidate.path === normalizedPath)
    return Boolean(file?.tables.some((table) => String(table.meta?.template_id || '') === EMAIL_INBOX_SYNC_TEMPLATE_ID))
  } catch {
    return false
  }
}
