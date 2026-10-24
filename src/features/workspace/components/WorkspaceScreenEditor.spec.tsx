import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workspace/components/WorkspaceEditorContent', () => ({ WorkspaceEditorContent: () => null }))
vi.mock('@/features/workspace/components/WorkspaceEditorPane', () => ({ WorkspaceEditorPane: () => null }))

import type { AgentSession } from '@/api/agent'

import { buildWorkspaceEditorContentProps, type WorkspaceScreenEditorInput } from './WorkspaceScreenEditor'

const session = { id: 5, title: 'Chat' } as AgentSession

function buildInput(overrides: Partial<WorkspaceScreenEditorInput> = {}) {
  const agentPanel = { open: false, setOpen: vi.fn(), setHistoryOpen: vi.fn() }
  const templateDialogs = { openDocumentTemplateDialog: vi.fn() }
  const onCreateTable = vi.fn()
  const input: WorkspaceScreenEditorInput = {
    rootPath: '/vault',
    workspaceTabs: [],
    activeWorkspaceTab: undefined,
    activeWorkspaceTabId: '',
    galleryPanelProps: null,
    agentPanel,
    activeAgentSession: session,
    stopAgentMessage: vi.fn(),
    design: { available: true, onBridgeChange: vi.fn(), onGenerateImage: undefined },
    templateDialogs,
    workflows: { openTableFileWorkflow: vi.fn(), openWorkspaceWorkflow: vi.fn() },
    onCreateTable,
    ...overrides,
  }
  return { input, agentPanel, templateDialogs, onCreateTable }
}

describe('buildWorkspaceEditorContentProps', () => {
  it('stops the agent’s design work in the active session, and offers no stop without one', () => {
    const { input } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    expect(props.onCancelDesignAgent).toBeDefined()
    props.onCancelDesignAgent!()
    expect(input.stopAgentMessage).toHaveBeenCalledWith(5)

    const idle = buildWorkspaceEditorContentProps(buildInput({ activeAgentSession: null }).input)
    expect(idle.onCancelDesignAgent).toBeUndefined()
  })

  it('opens the Agent panel and focuses the composer', () => {
    const { input, agentPanel } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    const listener = vi.fn()
    window.addEventListener('kition:agent:focus-composer', listener)
    props.onOpenAgent()
    window.removeEventListener('kition:agent:focus-composer', listener)
    expect(agentPanel.setOpen).toHaveBeenCalledWith(true)
    expect(agentPanel.setHistoryOpen).toHaveBeenCalledWith(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('opens the note templates at the workspace root, and a new table file, from the empty state', () => {
    const { input, templateDialogs, onCreateTable } = buildInput()
    const props = buildWorkspaceEditorContentProps(input)
    props.onCreateDocument()
    props.onCreateTable()
    expect(templateDialogs.openDocumentTemplateDialog).toHaveBeenCalledWith('')
    expect(onCreateTable).toHaveBeenCalledOnce()
  })
})
