import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEditorContent } from './WorkspaceEditorContent'

vi.mock('@/features/workflow/pages/WorkflowIndexPage', () => ({
  WorkflowIndexPage: ({ onSelectWorkflow }: { onSelectWorkflow: (workflowId: string, tablePath?: string) => void }) => (
    <>
      <button type="button" data-testid="mock-workflow-row" onClick={() => onSelectWorkflow('auto_1', 'Leads.ktable')}>
        Open scoped workflow
      </button>
      <button type="button" data-testid="mock-global-workflow-row" onClick={() => onSelectWorkflow('auto_2')}>
        Open global workflow
      </button>
    </>
  ),
}))

vi.mock('@/features/workflow/pages/WorkflowHomePage', () => ({
  WorkflowHomePage: () => <div data-testid="mock-workflow-detail" />,
}))

vi.mock('@/features/emailSync/EmailSyncWorkflowPage', () => ({
  EmailSyncWorkflowPage: ({ workflowId }: { workflowId: string }) => <div data-testid="mock-email-sync-workflow-detail">{workflowId}</div>,
}))

vi.mock('@/features/formSync/FormSyncWorkflowPage', () => ({
  FormSyncWorkflowPage: ({ workflowId }: { workflowId: string }) => <div data-testid="mock-form-sync-workflow-detail">{workflowId}</div>,
}))

let container: HTMLDivElement
let root: Root | null = null

function baseProps() {
  return {
    activeWorkspaceTabId: 'workflow:home',
    galleryPanelProps: null,
    onOpenWorkflows: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateTable: vi.fn(),
    onOpenAgent: vi.fn(),
    rootPath: '/workspace',
  } as const
}

async function render(props: Record<string, unknown>) {
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(WorkspaceEditorContent, props as any))
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
})

describe('WorkspaceEditorContent workflow routing', () => {
  it('renders functional quick starts when no workspace tab is active', async () => {
    const onCreateDocument = vi.fn()
    const onCreateTable = vi.fn()
    const onOpenAgent = vi.fn()
    const onOpenWorkflows = vi.fn()
    await render({
      ...baseProps(),
      activeWorkspaceTab: undefined,
      activeWorkspaceTabId: '',
      workspaceTabs: [],
      onCreateDocument,
      onCreateTable,
      onOpenAgent,
      onOpenWorkflows,
    })

    expect(container.querySelector('[data-testid="workspace-empty-state"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.workspace-empty-state__prompt')?.click()
      container.querySelectorAll<HTMLButtonElement>('.workspace-empty-state__action-card')[0]?.click()
      container.querySelectorAll<HTMLButtonElement>('.workspace-empty-state__action-card')[1]?.click()
      container.querySelectorAll<HTMLButtonElement>('.workspace-empty-state__action-card')[2]?.click()
    })

    expect(onOpenAgent).toHaveBeenCalledOnce()
    expect(onCreateDocument).toHaveBeenCalledOnce()
    expect(onCreateTable).toHaveBeenCalledOnce()
    expect(onOpenWorkflows).toHaveBeenCalledOnce()
  })

  it('renders email sync IDs with the email workflow detail surface', async () => {
    const tab = {
      id: 'workflow:Mail/Emails.ktable',
      type: 'workflow' as const,
      title: 'Emails',
      tablePath: 'Mail/Emails.ktable',
      workflowId: 'mail_1',
    }
    await render({
      ...baseProps(),
      activeWorkspaceTabId: tab.id,
      activeWorkspaceTab: tab,
      workspaceTabs: [tab],
    })

    expect(container.querySelector('[data-testid="mock-email-sync-workflow-detail"]')?.textContent).toBe('mail_1')
    expect(container.querySelector('[data-testid="mock-workflow-detail"]')).toBeNull()
  })

  it('renders form sync IDs with the form builder surface', async () => {
    const tab = {
      id: 'workflow:Events.ktable',
      type: 'workflow' as const,
      title: 'Events',
      tablePath: 'Events.ktable',
      workflowId: 'formsync_1',
    }
    await render({
      ...baseProps(),
      activeWorkspaceTabId: tab.id,
      activeWorkspaceTab: tab,
      workspaceTabs: [tab],
    })

    expect(container.querySelector('[data-testid="mock-form-sync-workflow-detail"]')?.textContent).toBe('formsync_1')
    expect(container.querySelector('[data-testid="mock-workflow-detail"]')).toBeNull()
  })

  it('opens a workflow from the global list in its resolved table file tab', async () => {
    const onOpenWorkflow = vi.fn()
    const onOpenGlobalWorkflow = vi.fn()
    const tab = { id: 'workflow:home', type: 'workflow' as const, title: 'Workflows' }
    await render({
      ...baseProps(),
      activeWorkspaceTab: tab,
      workspaceTabs: [tab],
      onOpenWorkflow,
      onOpenGlobalWorkflow,
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-workflow-row"]')?.click()
    })
    expect(onOpenWorkflow).toHaveBeenCalledWith('Leads.ktable', 'auto_1')
    expect(onOpenGlobalWorkflow).not.toHaveBeenCalled()
  })

  it('keeps workflows without a resolved table file in the global tab', async () => {
    const onOpenGlobalWorkflow = vi.fn()
    const tab = { id: 'workflow:home', type: 'workflow' as const, title: 'Workflows' }
    await render({
      ...baseProps(),
      activeWorkspaceTab: tab,
      workspaceTabs: [tab],
      onOpenGlobalWorkflow,
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-global-workflow-row"]')?.click()
    })
    expect(onOpenGlobalWorkflow).toHaveBeenCalledWith('auto_2')
  })

  it('keeps the workflow selection of a table file scoped to its tab', async () => {
    const onOpenWorkflow = vi.fn()
    const tab = {
      id: 'workflow:Leads.ktable',
      type: 'workflow' as const,
      title: 'Leads',
      tablePath: 'Leads.ktable',
    }
    await render({
      ...baseProps(),
      activeWorkspaceTabId: tab.id,
      activeWorkspaceTab: tab,
      workspaceTabs: [tab],
      onOpenWorkflow,
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-global-workflow-row"]')?.click()
    })
    expect(onOpenWorkflow).toHaveBeenCalledWith('Leads.ktable', 'auto_2')
  })
})
