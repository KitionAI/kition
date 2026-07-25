import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listWorkflowRuns, listWorkflows } from '@/features/workflow/api'
import { useWorkflowLauncherState } from '@/features/workflow/hooks/useWorkflowLauncherState'
import { useWorkflowTableLabels } from '@/features/workflow/hooks/useWorkflowTableLabels'
import { ensureOnboardingWorkflow } from '@/features/workflow/lib/ensureOnboardingWorkflow'
import { useTableEmailSyncWorkflows } from '@/features/emailSync/useTableEmailSyncWorkflows'
import { WorkflowIndexPage } from './WorkflowIndexPage'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/features/workflow/api', () => ({
  WORKFLOW_CHANGED_EVENT: 'kition:workflow:changed',
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
}))
vi.mock('@/features/workflow/hooks/useWorkflowLauncherState', () => ({
  useWorkflowLauncherState: vi.fn(),
}))
vi.mock('@/features/workflow/hooks/useWorkflowTableLabels', () => ({
  useWorkflowTableLabels: vi.fn(),
}))
vi.mock('@/features/workflow/lib/ensureOnboardingWorkflow', () => ({
  ensureOnboardingWorkflow: vi.fn(),
}))
vi.mock('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog', () => ({
  WorkspaceWorkflowCreateModeDialog: () => null,
}))
vi.mock('@/features/emailSync/useTableEmailSyncWorkflows', () => ({
  normalizeEmailSyncTablePath: (path: string) => path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, ''),
  useTableEmailSyncWorkflows: vi.fn(),
}))
vi.mock('@/features/emailSync/EmailSyncOnboardingWorkflowPage', () => ({
  EmailSyncOnboardingWorkflowPage: ({ tablePath }: { tablePath: string }) => (
    <div data-testid="mock-email-sync-onboarding-workflow">{tablePath}</div>
  ),
}))
vi.mock('@/features/emailSync/EmailSyncWorkflowPage', () => ({
  EmailSyncWorkflowPage: ({ workflowId }: { workflowId: string }) => (
    <div data-testid="mock-email-sync-workflow-page">{workflowId}</div>
  ),
}))

let container: HTMLDivElement
let root: Root | null = null

async function mount(scopedKitablePath = 'Getting Started/Guides/Lead Automation/Lead Follow-up.kitable') {
  const onSelectWorkflow = vi.fn()
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WorkflowIndexPage, {
      scopedKitablePath,
      rootPath: '/vault',
      onSelectWorkflow,
    }))
    await Promise.resolve()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSelectWorkflow
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(listWorkflows).mockResolvedValue([])
  vi.mocked(listWorkflowRuns).mockResolvedValue([])
  vi.mocked(useWorkflowTableLabels).mockReturnValue({
    labels: {},
    status: 'done',
  })
  vi.mocked(useWorkflowLauncherState).mockReturnValue({
    busyAction: null,
    busyTemplateId: undefined,
    error: null,
    runTemplate: vi.fn(),
    runScratch: vi.fn(),
    clearError: vi.fn(),
    handleAgent: vi.fn(),
  })
  vi.mocked(ensureOnboardingWorkflow).mockResolvedValue({
    created: [{ id: 'wf_lead_email' } as never],
    existing: [],
  })
  vi.mocked(useTableEmailSyncWorkflows).mockReturnValue({
    status: 'ready',
    supported: true,
    workflows: [],
    latestRuns: {},
    error: '',
  })
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

describe('WorkflowIndexPage onboarding workflow preparation', () => {
  it('materializes and opens the lead email workflow for its scoped Kitable', async () => {
    const onSelectWorkflow = await mount()

    expect(ensureOnboardingWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      scopedKitablePath: 'Getting Started/Guides/Lead Automation/Lead Follow-up.kitable',
      rootPath: '/vault',
      workflows: [],
    }))
    expect(onSelectWorkflow).toHaveBeenCalledWith('wf_lead_email')
  })

  it('shows a configured email sync in the shared workflow table', async () => {
    vi.mocked(ensureOnboardingWorkflow).mockResolvedValueOnce({ created: [], existing: [] })
    vi.mocked(useTableEmailSyncWorkflows).mockReturnValue({
      status: 'ready',
      supported: true,
      workflows: [{
        id: 'mail_1',
        name: 'Personal inbox',
        connection: { host: 'imap.example.com', port: 993, tls_mode: 'tls', username: 'person@example.com', mailbox: 'INBOX' },
        target: { table_path: 'Projects/Customer Requests.kitable', content_folder: 'Mail', attachment_folder: 'Mail/Attachments' },
        schedule: { enabled: true, interval_minutes: 15 },
        include_attachments: true,
        status: 'active',
        synced_messages: 3,
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:00:00Z',
      }],
      latestRuns: {
        mail_1: {
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
          table_path: 'Projects/Customer Requests.kitable',
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:01:00Z',
        },
      },
      error: '',
    })
    const onSelectWorkflow = await mount('Projects/Customer Requests.kitable')

    expect(container.querySelector('[data-testid="email-sync-workflow-row"]')?.textContent)
      .toContain('Personal inbox')
    expect(container.querySelector('[data-testid="email-sync-workflow-row"]')?.textContent)
      .toContain('Sync all · 240 / 500 processed')
    container.querySelector<HTMLTableRowElement>('[data-testid="email-sync-workflow-row"]')?.click()
    expect(onSelectWorkflow).toHaveBeenCalledWith('mail_1', 'Projects/Customer Requests.kitable')
    expect(container.querySelector('[data-testid="table-email-sync-workflow-index"]')).toBeNull()
    expect(container.querySelector('[data-testid="workflow-index-empty"]')).toBeNull()
  })

  it('opens the included email sync workflow for the onboarding inbox', async () => {
    vi.mocked(ensureOnboardingWorkflow).mockResolvedValueOnce({ created: [], existing: [] })
    await mount('Getting Started/Guides/Email Automation/Inbox.kitable')

    expect(container.querySelector('[data-testid="mock-email-sync-onboarding-workflow"]')?.textContent)
      .toBe('Getting Started/Guides/Email Automation/Inbox.kitable')
    expect(container.querySelector('[data-testid="workflow-index-empty"]')).toBeNull()
    expect(ensureOnboardingWorkflow).not.toHaveBeenCalled()
  })

  it('renders the single configured onboarding inbox workflow directly', async () => {
    vi.mocked(useTableEmailSyncWorkflows).mockReturnValue({
      status: 'ready',
      supported: true,
      workflows: [{
        id: 'mail_onboarding',
        name: 'Personal inbox',
        connection: { host: 'imap.example.com', port: 993, tls_mode: 'tls', username: 'person@example.com', mailbox: 'INBOX' },
        target: {
          table_path: 'Getting Started/Guides/Email Automation/Inbox.kitable',
          content_folder: 'Mail/Messages',
          attachment_folder: 'Mail/Attachments',
        },
        schedule: { enabled: true, interval_minutes: 15 },
        include_attachments: true,
        status: 'active',
        synced_messages: 10,
        created_at: '2026-07-23T00:00:00Z',
        updated_at: '2026-07-23T00:00:00Z',
      }],
      latestRuns: {},
      error: '',
    })

    const onSelectWorkflow = await mount('Getting Started/Guides/Email Automation/Inbox.kitable')

    expect(container.querySelector('[data-testid="mock-email-sync-workflow-page"]')?.textContent)
      .toBe('mail_onboarding')
    expect(onSelectWorkflow).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="email-sync-workflow-row"]')).toBeNull()
  })
})
