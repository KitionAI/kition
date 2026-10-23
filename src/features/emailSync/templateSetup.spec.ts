import { describe, expect, it, vi } from 'vitest'

import { listTableFiles } from '@/api/kitTables'
import {
  EMAIL_INBOX_SYNC_TEMPLATE_ID,
  isEmailInboxSyncTemplateTable,
} from './templateSetup'
import { ONBOARDING_EMAIL_INBOX_SYNC_PATH } from '@/features/onboarding/onboardingManifest'

vi.mock('@/api/kitTables', () => ({
  listTableFiles: vi.fn(),
}))

function filesWith(path: string, templateId: string) {
  return { files: [{ path, documentId: null, dashboards: [], tables: [{ id: '1', name: 'inbox', title: 'Inbox', meta: { template_id: templateId }, fields: [] }] }], unreadable: [] }
}

describe('email inbox sync template setup', () => {
  it('recognizes the categorized onboarding inbox even when runtime metadata was not preserved', async () => {
    await expect(isEmailInboxSyncTemplateTable(ONBOARDING_EMAIL_INBOX_SYNC_PATH))
      .resolves.toBe(true)
    expect(listTableFiles).not.toHaveBeenCalled()
  })

  it('recognizes a table file created from the email inbox template', async () => {
    vi.mocked(listTableFiles).mockResolvedValue(filesWith('Projects/Inbox.ktable', EMAIL_INBOX_SYNC_TEMPLATE_ID))
    await expect(isEmailInboxSyncTemplateTable('Projects/Inbox.ktable')).resolves.toBe(true)
  })

  it('ignores unrelated or unavailable table files', async () => {
    vi.mocked(listTableFiles).mockResolvedValueOnce(filesWith('Projects/Tasks.ktable', 'task-tracker'))
    await expect(isEmailInboxSyncTemplateTable('Projects/Tasks.ktable')).resolves.toBe(false)

    vi.mocked(listTableFiles).mockRejectedValueOnce(new Error('unavailable'))
    await expect(isEmailInboxSyncTemplateTable('Projects/Missing.ktable')).resolves.toBe(false)
  })
})
