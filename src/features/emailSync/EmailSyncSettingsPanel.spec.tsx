import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDesktopBackendStatus } from '@/services/desktop'
import { openDataDocumentByPath } from '@/api/dataDocuments'
import {
  createEmailSyncWorkflow,
  listEmailSyncWorkflows,
  startEmailSyncRun,
} from './api'
import { EmailSyncSettingsPanel, runtimeSupportsEmailSync } from './EmailSyncSettingsPanel'
import type { EmailProviderId } from '@/features/emailProviders/emailProviderCatalog'

vi.mock('@/services/desktop', () => ({
  getDesktopBackendStatus: vi.fn(),
}))

vi.mock('@/api/dataDocuments', () => ({
  openDataDocumentByPath: vi.fn(),
}))

vi.mock('@/components/confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
}))

vi.mock('./api', () => ({
  EMAIL_SYNC_CHANGED_EVENT: 'kition:email-sync:changed',
  createEmailSyncWorkflow: vi.fn(),
  deleteEmailSyncWorkflow: vi.fn(),
  listEmailSyncWorkflows: vi.fn(),
  startEmailSyncRun: vi.fn(),
  testEmailSyncWorkflow: vi.fn(),
  updateEmailSyncWorkflow: vi.fn(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

const workflow = {
  id: 'mail_1',
  name: '163 Mail inbox',
  connection: { host: 'imap.163.com', port: 993, tls_mode: 'tls', username: 'person@163.com', mailbox: 'INBOX' },
  target: { table_path: 'Mail/Emails.kitable', table_id: 12, content_folder: 'Mail/Messages', attachment_folder: 'Mail/Attachments' },
  schedule: { enabled: false, interval_minutes: 15 },
  include_attachments: true,
  status: 'paused',
  synced_messages: 10,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(getDesktopBackendStatus).mockResolvedValue({ capabilities: ['email_sync'] } as never)
  vi.mocked(openDataDocumentByPath).mockResolvedValue({
    tables: [{ id: 12, name: 'inbox', title: 'Inbox' }],
  } as never)
  vi.mocked(listEmailSyncWorkflows).mockResolvedValue([])
  vi.mocked(createEmailSyncWorkflow).mockResolvedValue(workflow as never)
  vi.mocked(startEmailSyncRun).mockResolvedValue({
    id: 'mailrun_1',
    workflow_id: 'mail_1',
    mode: 'incremental',
    status: 'queued',
    discovered_messages: 0,
    processed_messages: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    current_batch: 0,
    table_path: 'Mail/Emails.kitable',
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:00Z',
  })
  sessionStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
  sessionStorage.clear()
})

async function mount(providerId: EmailProviderId = 'gmail', props: Record<string, unknown> = {}) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(EmailSyncSettingsPanel, { providerId, ...props }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setValue(testId: string, value: string) {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('EmailSyncSettingsPanel', () => {
  it('detects the runtime capability explicitly', () => {
    expect(runtimeSupportsEmailSync({ capabilities: ['documents', 'email_sync'] } as never)).toBe(true)
    expect(runtimeSupportsEmailSync({ capabilities: ['documents'] } as never)).toBe(false)
    expect(runtimeSupportsEmailSync(null)).toBe(false)
  })

  it('does not call email sync endpoints when the capability is missing', async () => {
    vi.mocked(getDesktopBackendStatus).mockResolvedValueOnce({ capabilities: [] } as never)
    await mount()

    expect(container.textContent).toContain('does not provide the email_sync capability')
    expect(listEmailSyncWorkflows).not.toHaveBeenCalled()
  })

  it('creates a mailbox workflow from a provider preset', async () => {
    await mount('163')
    expect(container.querySelector('[data-testid="email-sync-mailbox-scope-note"]')?.textContent)
      .toContain('set the client receive range to all messages')
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Advanced'))?.click()
    })
    setValue('email-sync-port', '465')
    setValue('email-sync-username', 'person@163.com')
    setValue('email-sync-password', 'app-password')

    await act(async () => {
      const saveButton = container.querySelector('[data-testid="email-sync-save"]') as HTMLButtonElement
      saveButton.click()
      await Promise.resolve()
    })

    expect(createEmailSyncWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      name: '163 Mail inbox',
      password: 'app-password',
      connection: expect.objectContaining({ host: 'imap.163.com', port: 993, tls_mode: 'tls', mailbox: 'INBOX' }),
      target: {
        table_path: 'Getting Started/Guides/Email Automation/Inbox.kitable',
        table_id: 12,
        content_folder: 'Mail/Messages',
        attachment_folder: 'Mail/Attachments',
      },
    }))
  })

  it('starts a full sync after saving the full inbox template', async () => {
    const onSaved = vi.fn()
    await mount('163', { runAfterSave: 'full', onSaved })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Advanced'))?.click()
    })
    setValue('email-sync-username', 'person@163.com')
    setValue('email-sync-password', 'app-password')

    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="email-sync-save"]')
    expect(saveButton?.textContent).toContain('Save and sync all')
    await act(async () => {
      saveButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()

    expect(startEmailSyncRun).toHaveBeenCalledWith('mail_1', 'full')
    expect(onSaved).toHaveBeenCalledWith(workflow)
  })

  it('opens a prefilled setup form requested from a table workflow tab', async () => {
    await mount('gmail', {
      requestedTablePath: 'Getting Started/Guides/Email Automation/Inbox.kitable',
    })

    expect(container.querySelector('[data-testid="email-sync-table-select"]')?.textContent).toContain('Inbox')
    expect(container.textContent).toContain('Current Kitable: Getting Started/Guides/Email Automation/Inbox.kitable')
  })

  it('keeps a requested table in create mode when the provider has another destination', async () => {
    vi.mocked(listEmailSyncWorkflows).mockResolvedValue([workflow as never])
    await mount('163', { requestedTablePath: 'Projects/Customer Requests.kitable' })

    expect(container.textContent).toContain('Current Kitable: Projects/Customer Requests.kitable')
    expect(container.querySelector('[data-testid="email-sync-status-summary"]')).toBeNull()
  })

  it('searches tables in the current Kitable and saves the selected table ID', async () => {
    vi.mocked(openDataDocumentByPath).mockResolvedValue({
      tables: [
        { id: 12, name: 'prospects', title: 'Prospects' },
        { id: 13, name: 'touchpoints', title: 'Touchpoints' },
      ],
    } as never)
    await mount('163', { requestedTablePath: 'Projects/Sales.kitable' })
    await flush()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="email-sync-table-select"]')?.click()
      await Promise.resolve()
    })
    const search = document.body.querySelector('[data-testid="email-sync-table-search"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'touch')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="email-sync-table-option-13"]')?.click()
    })
    setValue('email-sync-username', 'person@163.com')
    setValue('email-sync-password', 'app-password')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="email-sync-save"]')?.click()
      await Promise.resolve()
    })

    expect(createEmailSyncWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        table_path: 'Projects/Sales.kitable',
        table_id: 13,
      }),
    }))
  })

  it('starts an incremental run owned by the selected workflow', async () => {
    vi.mocked(listEmailSyncWorkflows).mockResolvedValue([workflow as never])
    await mount('163')
    await act(async () => {
      const syncButton = container.querySelector('[data-testid="email-sync-run"]') as HTMLButtonElement
      syncButton.click()
      await Promise.resolve()
    })
    await flush()

    expect(startEmailSyncRun).toHaveBeenCalledWith('mail_1', 'incremental')
    expect(container.textContent).toContain('Sync started. Progress and results are available on the corresponding workflow.')
  })

  it('syncs every remaining batch from a selected mailbox', async () => {
    vi.mocked(listEmailSyncWorkflows)
      .mockResolvedValueOnce([{ ...workflow } as never])
      .mockResolvedValue([{
        ...workflow,
        synced_messages: 255,
        last_sync_at: '2026-07-22T00:01:00Z',
      } as never])
    await mount('163')
    await act(async () => {
      const syncAllButton = container.querySelector('[data-testid="email-sync-run-all"]') as HTMLButtonElement
      syncAllButton.click()
      await Promise.resolve()
    })
    await flush()

    expect(startEmailSyncRun).toHaveBeenCalledWith('mail_1', 'full')
    expect(container.textContent).toContain('Full sync started. Progress and results are available on the corresponding workflow.')
    expect(container.querySelector('[data-testid="email-sync-status-summary"]')?.textContent).toContain('Messages synced255')
    expect(container.querySelector('[data-testid="email-sync-status-summary"]')?.textContent).toContain('Inbox')
  })
})
