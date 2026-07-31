import { openDataDocumentByPath } from '@/api/dataDocuments'

export const EMAIL_INBOX_SYNC_TEMPLATE_ID = 'email-inbox-sync'

export async function isEmailInboxSyncTemplateTable(tablePath: string, rootPath?: string) {
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
