import { describe, expect, it } from 'vitest'

import type { EmailSyncWorkflow } from '@/api/emailSync'
import {
  filterEmailSyncWorkflowsByTablePath,
  normalizeEmailSyncTablePath,
  resolveEmailSyncTableBinding,
} from './useTableEmailSyncWorkflows'

const workflow = (id: string, tablePath: string): EmailSyncWorkflow => ({
  id,
  name: id,
  connection: { host: 'imap.example.com', port: 993, tls_mode: 'tls', username: 'person@example.com', mailbox: 'INBOX' },
  target: { table_path: tablePath, content_folder: 'Mail', attachment_folder: 'Mail/Attachments' },
  schedule: { enabled: false, interval_minutes: 15 },
  include_attachments: true,
  status: 'paused',
  synced_messages: 0,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
})

describe('table email sync workflow matching', () => {
  it('normalizes separators without changing the table identity', () => {
    expect(normalizeEmailSyncTablePath('\\Projects\\Inbox.ktable\\')).toBe('Projects/Inbox.ktable')
  })

  it('returns only workflows bound to the current table file', () => {
    const result = filterEmailSyncWorkflowsByTablePath([
      workflow('matching', 'Projects/Inbox.ktable'),
      workflow('other', 'Projects/Archive.ktable'),
    ], '/Projects/Inbox.ktable/')

    expect(result.map((item) => item.id)).toEqual(['matching'])
  })

  it('migrates the single unused legacy default into the onboarding inbox', () => {
    const legacy = workflow('legacy', 'Mail/Emails.ktable')
    const result = resolveEmailSyncTableBinding(
      [legacy],
      'Getting Started/Guides/Email Automation/Inbox.ktable',
    )

    expect(result.workflows).toEqual([])
    expect(result.migrationCandidate?.id).toBe('legacy')
  })

  it('does not retarget a legacy workflow after messages were imported', () => {
    const legacy = { ...workflow('legacy', 'Mail/Emails.ktable'), synced_messages: 12 }
    const result = resolveEmailSyncTableBinding(
      [legacy],
      'Getting Started/Guides/Email Automation/Inbox.ktable',
    )

    expect(result.migrationCandidate).toBeNull()
  })
})
