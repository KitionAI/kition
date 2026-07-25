import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cancelEmailSyncRun,
  listEmailSyncRuns,
  listEmailSyncWorkflows,
  startEmailSyncRun,
} from './api'
import { EmailSyncWorkflowPage } from './EmailSyncWorkflowPage'
import { openDataDocumentByPath } from '@/api/dataDocuments'

vi.mock('./api', () => ({
  EMAIL_SYNC_CHANGED_EVENT: 'kition:email-sync:changed',
  cancelEmailSyncRun: vi.fn(),
  deleteEmailSyncWorkflow: vi.fn(),
  listEmailSyncRuns: vi.fn(),
  listEmailSyncWorkflows: vi.fn(),
  retryEmailSyncRun: vi.fn(),
  startEmailSyncRun: vi.fn(),
  updateEmailSyncWorkflow: vi.fn(),
}))

vi.mock('@/components/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }))
vi.mock('@/api/dataDocuments', () => ({ openDataDocumentByPath: vi.fn() }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const workflow = {
  id: 'mail_1',
  name: '163 Mail inbox',
  connection: { host: 'imap.163.com', port: 993, tls_mode: 'tls', username: 'person@163.com', mailbox: 'INBOX' },
  target: { table_path: 'Mail/Emails.kitable', table_id: 12, content_folder: 'Mail/Messages', attachment_folder: 'Mail/Attachments' },
  schedule: { enabled: true, interval_minutes: 15 },
  include_attachments: true,
  status: 'syncing',
  synced_messages: 120,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const activeRun = {
  id: 'mailrun_1',
  workflow_id: 'mail_1',
  mode: 'full',
  status: 'running',
  discovered_messages: 500,
  processed_messages: 240,
  imported: 230,
  updated: 2,
  skipped: 8,
  failed: 0,
  current_batch: 3,
  table_path: 'Mail/Emails.kitable',
  started_at: '2026-07-22T00:00:00Z',
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:01:00Z',
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listEmailSyncWorkflows).mockResolvedValue([workflow as never])
  vi.mocked(listEmailSyncRuns).mockResolvedValue([activeRun as never])
  vi.mocked(cancelEmailSyncRun).mockResolvedValue({ ...activeRun, status: 'canceling' } as never)
  vi.mocked(startEmailSyncRun).mockResolvedValue({ ...activeRun, status: 'queued' } as never)
  vi.mocked(openDataDocumentByPath).mockResolvedValue({
    tables: [{ id: 12, name: 'inbox', title: 'Inbox' }],
  } as never)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function mount() {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(EmailSyncWorkflowPage, { workflowId: 'mail_1' }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EmailSyncWorkflowPage', () => {
  it('shows the full-sync progress on the corresponding workflow', async () => {
    await mount()
    expect(container.querySelector('[data-testid="workflow-canvas"]')).not.toBeNull()
    expect(container.querySelector('[data-node-role="trigger"]')?.textContent).toContain('Scheduled trigger')
    expect(container.querySelector('[data-node-role="action"]')?.textContent).toContain('Sync email inbox')
    expect(container.querySelector('[data-node-role="action"]')?.textContent).toContain('Inbox')
    expect(container.textContent).toContain('Syncing all email')
    expect(container.textContent).toContain('240 of 500 processed')
    expect(container.textContent).toContain('48%')
  })

  it('opens run history and cancels the active workflow run', async () => {
    await mount()
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Run history'))?.click()
      await Promise.resolve()
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Cancel'))?.click()
      await Promise.resolve()
    })
    expect(cancelEmailSyncRun).toHaveBeenCalledWith('mailrun_1')
  })

  it('opens node-specific configuration in the shared workflow drawer', async () => {
    await mount()

    await act(async () => {
      container.querySelector<HTMLElement>('[data-node-role="trigger"]')?.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="workflow-properties-drawer"]')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('[data-testid="email-sync-trigger-schedule"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLElement>('[data-node-role="action"]')?.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="email-sync-workflow-editor"]')?.getAttribute('data-layout')).toBe('panel')
  })

  it('starts sync all from the workflow after the previous run completes', async () => {
    vi.mocked(listEmailSyncRuns).mockResolvedValueOnce([{ ...activeRun, status: 'completed' } as never])
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="email-sync-workflow-sync-all"]')?.click()
      await Promise.resolve()
    })
    expect(startEmailSyncRun).toHaveBeenCalledWith('mail_1', 'full')
  })
})
