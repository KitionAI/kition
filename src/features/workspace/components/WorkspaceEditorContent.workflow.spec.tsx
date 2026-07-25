import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEditorContent } from './WorkspaceEditorContent'

vi.mock('@/features/workflow/pages/WorkflowIndexPage', () => ({
  WorkflowIndexPage: ({ onSelectWorkflow }: { onSelectWorkflow: (workflowId: string, kitablePath?: string) => void }) => (
    <>
      <button type="button" data-testid="mock-workflow-row" onClick={() => onSelectWorkflow('auto_1', 'Leads.kitable')}>
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

let container: HTMLDivElement
let root: Root | null = null

function baseProps() {
  return {
    activeDocument: null,
    activeDocumentFormat: 'markdown',
    activeWorkspaceTabId: 'workflow:home',
    documentTitle: '',
    draftContent: '',
    hasActiveDocument: false,
    editorLocked: false,
    editorMode: 'rich',
    editorPreviewHtml: '',
    editorResetVersions: {},
    galleryPanelProps: null,
    browserPanelPhase: 'empty',
    browserToolbarStatus: {
      url: '',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    },
    onBrowserNavigate: vi.fn(),
    onBrowserBack: vi.fn(),
    onBrowserForward: vi.fn(),
    onBrowserReload: vi.fn(),
    onBrowserStop: vi.fn(),
    getOpenedDocumentDraftEntry: vi.fn(() => null),
    onSaveDocumentTitle: vi.fn(),
    onSplitEditorChange: vi.fn(),
    onTableAgentOpenChange: vi.fn(),
    onSetEditorMode: vi.fn(),
    tableAgentOpen: false,
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
  it('renders email sync IDs with the email workflow detail surface', async () => {
    const tab = {
      id: 'kitable:Mail/Emails.kitable',
      type: 'workflow' as const,
      title: 'Emails',
      kitablePath: 'Mail/Emails.kitable',
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

  it('opens a workflow from the global list in its resolved kitable tab', async () => {
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
    expect(onOpenWorkflow).toHaveBeenCalledWith('Leads.kitable', 'auto_1')
    expect(onOpenGlobalWorkflow).not.toHaveBeenCalled()
  })

  it('keeps workflows without a resolved kitable in the global tab', async () => {
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

  it('keeps kitable workflow selection scoped to its kitable tab', async () => {
    const onOpenWorkflow = vi.fn()
    const tab = {
      id: 'kitable:Leads.kitable',
      type: 'workflow' as const,
      title: 'Leads',
      kitablePath: 'Leads.kitable',
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
    expect(onOpenWorkflow).toHaveBeenCalledWith('Leads.kitable', 'auto_2')
  })
})
