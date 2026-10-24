import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEditorContent } from './WorkspaceEditorContent'

const mocks = vi.hoisted(() => ({
  documentEditorProps: vi.fn(),
  markdownSourceEditorProps: vi.fn(),
}))

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

vi.mock('@/features/document/components/DocumentMarkdownEditorPane', () => ({
  DocumentMarkdownEditorPane: (props: { focusRequest?: number }) => {
    mocks.documentEditorProps(props)
    return <div data-testid="mock-document-editor" data-focus-request={props.focusRequest} />
  },
}))

vi.mock('@/features/document/components/MarkdownSourceEditor', () => ({
  MarkdownSourceEditor: (props: Record<string, unknown>) => {
    mocks.markdownSourceEditorProps(props)
    return <div data-testid="mock-markdown-source-editor" />
  },
}))

// The comments rail reads a real document session (text, replica, comment subscriptions); these
// tests pass a stand-in session, so the rail is a stub here (e2e/collab-comments.spec.ts covers it).
vi.mock('@/features/document/components/DocumentComments', () => ({
  DocumentComments: () => <div data-testid="mock-document-comments" />,
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
    getOpenedDocument: vi.fn(() => null),
    activeDocumentSession: null,
    onSaveDocumentTitle: vi.fn(),
    onOpenWorkflows: vi.fn(),
    onCreateDocument: vi.fn(),
    onCreateTable: vi.fn(),
    onOpenAgent: vi.fn(),
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
  mocks.documentEditorProps.mockClear()
  mocks.markdownSourceEditorProps.mockClear()
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
  it('forwards a blank-document focus request to the Markdown editor', async () => {
    const onAgentInsertionContextChange = vi.fn()
    const document = {
      path: 'Notes/Untitled note.md',
      name: 'Untitled note.md',
      content: '',
      format: 'markdown' as const,
    }
    const tab = {
      id: 'document:Notes/Untitled note.md',
      uid: 'document-1',
      type: 'document' as const,
      title: 'Untitled note',
      path: document.path,
      format: 'markdown' as const,
    }
    await render({
      ...baseProps(),
      activeDocument: document,
      activeWorkspaceTab: tab,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [tab],
      hasActiveDocument: true,
      documentEditorFocusRequest: 1,
      onAgentInsertionContextChange,
      getOpenedDocument: vi.fn(() => ({ document, format: 'markdown' })),
      activeDocumentSession: { path: document.path } as never,
    })

    expect(container.querySelector('[data-testid="mock-document-editor"]')?.getAttribute('data-focus-request')).toBe('1')
    expect(mocks.documentEditorProps).toHaveBeenCalledWith(expect.objectContaining({
      onAgentInsertionContextChange,
    }))
  })

  it('publishes source-editor cursor snapshots without parsing on cursor movement', async () => {
    const document = {
      path: 'Notes/Pendant.md',
      name: 'Pendant.md',
      content: '# Title\n\nBody',
      format: 'markdown' as const,
    }
    const tab = {
      id: 'document:Notes/Pendant.md',
      uid: 'document-2',
      type: 'document' as const,
      title: 'Pendant',
      path: document.path,
      format: 'markdown' as const,
    }
    const onAgentInsertionContextChange = vi.fn()
    await render({
      ...baseProps(),
      activeDocument: document,
      activeWorkspaceTab: tab,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [tab],
      hasActiveDocument: true,
      editorMode: 'source',
      draftContent: document.content,
      onAgentInsertionContextChange,
      getOpenedDocument: vi.fn(() => ({ document, format: 'markdown' })),
      activeDocumentSession: { path: document.path } as never,
    })

    const sourceProps = mocks.markdownSourceEditorProps.mock.calls.at(-1)?.[0] as {
      onCursorChange?: (snapshot: { markdown: string; cursorOffset: number }) => void
    }
    expect(sourceProps.onCursorChange).toBeTypeOf('function')
    sourceProps.onCursorChange?.({ markdown: document.content, cursorOffset: 8 })

    expect(onAgentInsertionContextChange).toHaveBeenCalledWith(
      document.path,
      {
        documentPath: document.path,
        markdown: document.content,
        cursorOffset: 8,
      },
    )
  })

  it('clears source-editor cursor context when revision review replaces the editor', async () => {
    const document = {
      path: 'Notes/Pendant.md',
      name: 'Pendant.md',
      content: '# Title\n\nBody',
      format: 'markdown' as const,
    }
    const tab = {
      id: 'document:Notes/Pendant.md',
      uid: 'document-2',
      type: 'document' as const,
      title: 'Pendant',
      path: document.path,
      format: 'markdown' as const,
    }
    const onAgentInsertionContextChange = vi.fn()
    const props = {
      ...baseProps(),
      activeDocument: document,
      activeWorkspaceTab: tab,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [tab],
      hasActiveDocument: true,
      editorMode: 'source' as const,
      draftContent: document.content,
      onAgentInsertionContextChange,
      getOpenedDocument: vi.fn(() => ({ document, format: 'markdown' as const })),
      activeDocumentSession: { path: document.path } as never,
    }
    await render(props)

    await act(async () => {
      root?.render(createElement(WorkspaceEditorContent, {
        ...props,
        activeDocumentRevision: {
          path: document.path,
          comparison: { changes: [] },
        } as never,
      } as any))
      await Promise.resolve()
    })

    expect(onAgentInsertionContextChange).toHaveBeenCalledWith(document.path, null)
  })

  it('forwards source cursor handling to split editor mode', async () => {
    const document = {
      path: 'Notes/Pendant.md',
      name: 'Pendant.md',
      content: '# Title\n\nBody',
      format: 'markdown' as const,
    }
    const tab = {
      id: 'document:Notes/Pendant.md',
      uid: 'document-3',
      type: 'document' as const,
      title: 'Pendant',
      path: document.path,
      format: 'markdown' as const,
    }
    await render({
      ...baseProps(),
      activeDocument: document,
      activeWorkspaceTab: tab,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [tab],
      hasActiveDocument: true,
      editorMode: 'split',
      draftContent: document.content,
      onAgentInsertionContextChange: vi.fn(),
      getOpenedDocument: vi.fn(() => ({ document, format: 'markdown' })),
      activeDocumentSession: { path: document.path } as never,
    })

    await vi.waitFor(() => {
      expect(mocks.markdownSourceEditorProps.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        onCursorChange: expect.any(Function),
      }))
    })
  })

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
