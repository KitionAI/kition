import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEditorContent } from './WorkspaceEditorContent'

const mocks = vi.hoisted(() => ({
  documentEditorProps: vi.fn(),
  markdownSourceEditorProps: vi.fn(),
}))

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

vi.mock('@/features/whiteboard/components/WhiteboardEditorPane', () => ({
  WhiteboardEditorPane: () => (
    <svg data-testid="whiteboard-svg-scene" role="img" aria-label="Board" />
  ),
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
      getOpenedDocumentDraftEntry: vi.fn(() => ({ document, format: 'markdown' })),
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
      getOpenedDocumentDraftEntry: vi.fn(() => ({ document, format: 'markdown' })),
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
      getOpenedDocumentDraftEntry: vi.fn(() => ({ document, format: 'markdown' as const })),
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
      getOpenedDocumentDraftEntry: vi.fn(() => ({ document, format: 'markdown' })),
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

  it('mounts the native SVG Board even when AI runtime support is unavailable', async () => {
    const tab = {
      id: 'board:Planning.kiboard',
      type: 'board' as const,
      title: 'Planning',
      path: 'Planning.kiboard',
    }
    await render({
      ...baseProps(),
      activeWorkspaceTab: tab,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [tab],
    })
    expect(container.querySelector('[data-testid="whiteboard-svg-scene"]')).not.toBeNull()
    expect(container.querySelector('canvas')).toBeNull()
  })

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

  it('renders form sync IDs with the form builder surface', async () => {
    const tab = {
      id: 'kitable:Events.kitable',
      type: 'workflow' as const,
      title: 'Events',
      kitablePath: 'Events.kitable',
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
