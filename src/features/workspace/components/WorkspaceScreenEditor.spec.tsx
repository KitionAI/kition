import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workspace/components/WorkspaceEditorContent', () => ({ WorkspaceEditorContent: () => null }))
vi.mock('@/features/workspace/components/WorkspaceEditorPane', () => ({ WorkspaceEditorPane: () => null }))

import type { AgentSession } from '@/api/agent'

import { buildWorkspaceEditorContentProps, type WorkspaceScreenEditorInput } from './WorkspaceScreenEditor'

const session = { id: 5, title: 'Chat' } as AgentSession

function buildInput(overrides: Partial<WorkspaceScreenEditorInput> = {}) {
  const documentSession = {
    activeDocument: { path: 'notes/plan.md', name: 'plan.md', content: '' },
    activeDocumentFormat: 'markdown' as const,
    activeDocumentRevision: { path: 'notes/plan.md' } as never,
    draftContent: 'draft',
    editorResetVersions: {},
    documentRevisionSaving: false,
    getOpenedDocumentDraftEntry: () => null,
    decideDocumentRevisionChange: vi.fn(),
    resolveAllDocumentRevisionChanges: vi.fn(),
    handleDraftContentChange: vi.fn(),
    openDocument: vi.fn(),
  }
  const agentPanel = { open: false, setOpen: vi.fn(), setHistoryOpen: vi.fn() }
  const templateDialogs = { documentEditorFocusRequest: 3, openDocumentTemplateDialog: vi.fn(), openKitableTemplateDialog: vi.fn() }
  const input: WorkspaceScreenEditorInput = {
    rootPath: '/vault',
    workspaceTabs: [],
    activeWorkspaceTab: undefined,
    activeWorkspaceTabId: '',
    documentSession,
    editorView: { locked: false, editorMode: 'rich' },
    editorPreviewHtml: '',
    galleryPanelProps: null,
    browserPanel: {
      browserPanelPhase: 'ready',
      browserToolbarStatus: { url: '', canGoBack: false, canGoForward: false, isLoading: false },
      handleBrowserNavigate: vi.fn(async () => undefined),
      handleBrowserBack: vi.fn(),
      handleBrowserForward: vi.fn(),
      handleBrowserReload: vi.fn(),
      handleBrowserStop: vi.fn(),
    } as never,
    tableAgent: { browserOriginDocumentPath: '', handleContextChange: vi.fn() } as never,
    agentPanel,
    activeAgentSession: session,
    agentBusySessions: new Set([5]),
    stopAgentMessage: vi.fn(),
    whiteboard: { available: true, onBridgeChange: vi.fn(), onGenerateImage: undefined },
    design: { available: true, onBridgeChange: vi.fn(), onGenerateImage: undefined },
    templateDialogs,
    workflows: { createForKitable: vi.fn(), openKitableWorkflow: vi.fn(), openWorkspaceWorkflow: vi.fn() },
    onAskDocumentAgent: vi.fn(),
    documentTranslation: undefined,
    onAgentInsertionContextChange: vi.fn(),
    onSaveDocumentTitle: vi.fn(),
    onToolbarMount: vi.fn(),
    onSetEditorMode: vi.fn(),
    clearFeedback: vi.fn(),
    ...overrides,
  }
  return { input, documentSession, agentPanel, templateDialogs }
}

describe('buildWorkspaceEditorContentProps', () => {
  it('derives the title, presence, and busy state from the bundles', () => {
    const { input } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    expect(props.documentTitle).toBe('plan')
    expect(props.hasActiveDocument).toBe(true)
    expect(props.whiteboardAgentBusy).toBe(true)
    expect(props.documentEditorFocusRequest).toBe(3)
    expect(props.onCancelWhiteboardAgent).toBeDefined()
    props.onCancelWhiteboardAgent!()
    expect(input.stopAgentMessage).toHaveBeenCalledWith(5)

    const idle = buildWorkspaceEditorContentProps(buildInput({ activeAgentSession: null }).input)
    expect(idle.whiteboardAgentBusy).toBe(false)
    expect(idle.onCancelWhiteboardAgent).toBeUndefined()
  })

  it('routes revision decisions to the pending revision path and ignores them without one', () => {
    const { input, documentSession } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    props.onDecideDocumentRevisionChange('c1', 'accept' as never)
    props.onResolveAllDocumentRevisionChanges('reject' as never)
    expect(documentSession.decideDocumentRevisionChange).toHaveBeenCalledWith('notes/plan.md', 'c1', 'accept')
    expect(documentSession.resolveAllDocumentRevisionChanges).toHaveBeenCalledWith('notes/plan.md', 'reject')

    const none = buildInput({ documentSession: { ...documentSession, activeDocumentRevision: null } })
    buildWorkspaceEditorContentProps(none.input).onDecideDocumentRevisionChange('c1', 'accept' as never)
    expect(none.documentSession.decideDocumentRevisionChange).not.toHaveBeenCalled()
  })

  it('opens the Agent panel and focuses the composer, and clears feedback on split edits', () => {
    const { input, agentPanel, documentSession } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    const listener = vi.fn()
    window.addEventListener('kition:agent:focus-composer', listener)
    props.onOpenAgent()
    window.removeEventListener('kition:agent:focus-composer', listener)
    expect(agentPanel.setOpen).toHaveBeenCalledWith(true)
    expect(agentPanel.setHistoryOpen).toHaveBeenCalledWith(false)
    expect(listener).toHaveBeenCalledTimes(1)

    props.onTableAgentOpenChange(false)
    expect(agentPanel.setOpen).toHaveBeenLastCalledWith(false)

    props.onSplitEditorChange('next')
    expect(documentSession.handleDraftContentChange).toHaveBeenCalledWith('next')
    expect(input.clearFeedback).toHaveBeenCalled()
  })

  it('opens template dialogs at the workspace root from the empty state', () => {
    const { input, templateDialogs } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    props.onCreateDocument()
    props.onCreateTable()
    expect(templateDialogs.openDocumentTemplateDialog).toHaveBeenCalledWith('')
    expect(templateDialogs.openKitableTemplateDialog).toHaveBeenCalledWith('')
  })
})
