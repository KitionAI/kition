import { describe, expect, it, vi } from 'vitest'

import { openDataDocumentByPath } from '@/api/dataDocuments'
import {
  EMAIL_INBOX_SYNC_TEMPLATE_ID,
  isEmailInboxSyncTemplateTable,
} from './templateSetup'

vi.mock('@/api/dataDocuments', () => ({
  openDataDocumentByPath: vi.fn(),
}))

describe('email inbox sync template setup', () => {
  it('recognizes a Kitable created from the email inbox template', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValue({
      meta: { template_id: EMAIL_INBOX_SYNC_TEMPLATE_ID },
    } as never)

    await expect(isEmailInboxSyncTemplateTable('Projects/Inbox.kitable', '/workspace'))
      .resolves.toBe(true)
    expect(openDataDocumentByPath).toHaveBeenCalledWith({
      path: 'Projects/Inbox.kitable',
      workspace_root: '/workspace',
    })
  })

  it('ignores unrelated or unavailable Kitable documents', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValueOnce({ meta: { template_id: 'task-tracker' } } as never)
    await expect(isEmailInboxSyncTemplateTable('Projects/Tasks.kitable')).resolves.toBe(false)

    vi.mocked(openDataDocumentByPath).mockRejectedValueOnce(new Error('unavailable'))
    await expect(isEmailInboxSyncTemplateTable('Projects/Missing.kitable')).resolves.toBe(false)
  })
})
