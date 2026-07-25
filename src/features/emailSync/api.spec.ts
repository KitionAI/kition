import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/api/request', () => ({ default: requestMock }))

import {
  createEmailSyncWorkflow,
  cancelEmailSyncRun,
  listEmailSyncRuns,
  listEmailSyncWorkflows,
  runAllEmailSyncWorkflow,
  runEmailSyncWorkflow,
  startEmailSyncRun,
  updateEmailSyncWorkflow,
} from './api'

afterEach(() => {
  vi.clearAllMocks()
})

const input = {
  name: 'Personal inbox',
  connection: {
    host: 'imap.example.com',
    port: 993,
    tls_mode: 'tls' as const,
    username: 'person@example.com',
    mailbox: 'INBOX',
  },
  password: 'app-password',
  target: {
    table_path: 'Mail/Emails.kitable',
    content_folder: 'Mail/Messages',
    attachment_folder: 'Mail/Attachments',
  },
  schedule: { enabled: false, interval_minutes: 15 },
  include_attachments: true,
}

describe('email sync API', () => {
  it('normalizes a missing workflow list to an empty array', async () => {
    requestMock.get.mockResolvedValueOnce({})
    await expect(listEmailSyncWorkflows()).resolves.toEqual([])
    expect(requestMock.get).toHaveBeenCalledWith('/v1/email-sync/workflows')
  })

  it('creates and updates workflows using the public contract', async () => {
    requestMock.post.mockResolvedValueOnce({ id: 'mail_1' })
    requestMock.patch.mockResolvedValueOnce({ id: 'mail_1' })

    await createEmailSyncWorkflow(input)
    await updateEmailSyncWorkflow('mail_1', { schedule: { enabled: true, interval_minutes: 30 } })

    expect(requestMock.post).toHaveBeenCalledWith('/v1/email-sync/workflows', input)
    expect(requestMock.patch).toHaveBeenCalledWith('/v1/email-sync/workflows/mail_1', {
      schedule: { enabled: true, interval_minutes: 30 },
    })
  })

  it('runs one incremental sync through the dedicated endpoint', async () => {
    const reload = vi.fn()
    window.addEventListener('kition:workspace-reload', reload)
    requestMock.post.mockResolvedValueOnce({ imported: 2, table_path: 'Mail/Emails.kitable' })
    await runEmailSyncWorkflow('mail_1')
    expect(requestMock.post).toHaveBeenCalledWith('/v1/email-sync/workflows/mail_1/sync', {})
    expect((reload.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      preferredPath: 'Mail/Emails.kitable',
      treeOnly: true,
    })
    window.removeEventListener('kition:workspace-reload', reload)
  })

  it('refreshes the workspace at the full-sync destination', async () => {
    const reload = vi.fn()
    window.addEventListener('kition:workspace-reload', reload)
    requestMock.post.mockResolvedValueOnce({ imported: 20, table_path: 'Mail/Archive.kitable' })
    await runAllEmailSyncWorkflow('mail_1')
    expect(requestMock.post).toHaveBeenCalledWith('/v1/email-sync/workflows/mail_1/sync-all', {})
    expect((reload.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      preferredPath: 'Mail/Archive.kitable',
      treeOnly: true,
    })
    window.removeEventListener('kition:workspace-reload', reload)
  })

  it('starts and lists persistent workflow runs', async () => {
    requestMock.post.mockResolvedValueOnce({ id: 'mailrun_1', workflow_id: 'mail_1', status: 'queued' })
    requestMock.get.mockResolvedValueOnce({ items: [{ id: 'mailrun_1' }] })

    await startEmailSyncRun('mail_1', 'full')
    await expect(listEmailSyncRuns('mail_1', 5)).resolves.toEqual([{ id: 'mailrun_1' }])

    expect(requestMock.post).toHaveBeenCalledWith('/v1/email-sync/workflows/mail_1/runs', { mode: 'full' })
    expect(requestMock.get).toHaveBeenCalledWith('/v1/email-sync/runs?workflow_id=mail_1&limit=5')
  })

  it('cancels a run without deleting its workflow', async () => {
    requestMock.post.mockResolvedValueOnce({ id: 'mailrun_1', status: 'canceling' })
    await cancelEmailSyncRun('mailrun_1')
    expect(requestMock.post).toHaveBeenCalledWith('/v1/email-sync/runs/mailrun_1/cancel', {})
  })
})
