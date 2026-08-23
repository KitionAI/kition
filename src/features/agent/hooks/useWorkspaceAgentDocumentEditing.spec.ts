import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
  listAgentEvents: vi.fn(),
  listAgentMessages: vi.fn(),
  listAgentSessions: vi.fn(),
  listAgentToolCalls: vi.fn(),
  streamAgentMessage: vi.fn(),
  isDesktopRuntime: vi.fn(),
  listWorkspaceDocuments: vi.fn(),
}))

vi.mock('@/api/agent', () => ({
  createAgentSession: mocks.createAgentSession,
  deleteAgentSession: mocks.deleteAgentSession,
  listAgentEvents: mocks.listAgentEvents,
  listAgentMessages: mocks.listAgentMessages,
  listAgentSessions: mocks.listAgentSessions,
  listAgentToolCalls: mocks.listAgentToolCalls,
  streamAgentMessage: mocks.streamAgentMessage,
}))

vi.mock('@/services/desktop', () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
  listWorkspaceDocuments: mocks.listWorkspaceDocuments,
}))

vi.mock('@/services/portalAccount', () => ({
  ensurePortalAccountSessionRestored: vi.fn(),
}))

vi.mock('@/services/desktopNotifications', () => ({
  notifyFromAgentEvent: vi.fn(),
}))

vi.mock('@/features/analytics/lib/productAnalytics', () => ({
  trackProductEventOnce: vi.fn(),
}))

vi.mock('@/features/table/lib/importWorkspaceFileIntoDataTable', () => ({
  importWorkspaceFileIntoDataTable: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  getCurrentLocale: () => 'en-US',
  getLanguageNameForLocale: () => 'English',
}))

function createOpenAISettings() {
  return {
    providers: {
      openai: {
        enabled: true,
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        discoveredModels: ['gpt-4.1'],
      },
    },
    models: {
      activeProvider: 'openai',
      selectedModelByProvider: { openai: 'gpt-4.1' },
      preferredChatModel: '',
      preferredWritingModel: '',
    },
  } as any
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceAgent document editing reliability', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.listAgentSessions.mockResolvedValue({ items: [] })
    mocks.streamAgentMessage.mockResolvedValue({ extra_data: {} })
    mocks.isDesktopRuntime.mockReturnValue(true)
  })

  async function mountAgent(options: Record<string, unknown> = {}) {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        ...options,
      })
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    return {
      getLatest: () => latest,
      unmount: async () => {
        await act(async () => root?.unmount())
        container.remove()
      },
    }
  }

  it('saves the active document before starting the agent stream', async () => {
    const order: string[] = []
    const prepareActiveDocument = vi.fn(async () => {
      order.push('save')
      return true
    })
    mocks.streamAgentMessage.mockImplementation(async () => {
      order.push('stream')
      return { extra_data: {} }
    })
    const harness = await mountAgent({ prepareActiveDocument })

    await act(async () => harness.getLatest().setAgentDraft(19, 'Improve the current article'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(19)
      await flushAsyncWork()
    })

    expect(prepareActiveDocument).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['save', 'stream'])
    await harness.unmount()
  })

  it('keeps the draft and blocks the agent when the active document cannot be saved', async () => {
    const onError = vi.fn()
    const harness = await mountAgent({
      onError,
      prepareActiveDocument: async () => false,
    })

    await act(async () => harness.getLatest().setAgentDraft(20, 'Improve the current article'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(20)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).not.toHaveBeenCalled()
    expect(harness.getLatest().agentDrafts[20]).toBe('Improve the current article')
    expect(harness.getLatest().agentMessages[20]).toBeUndefined()
    expect(onError).toHaveBeenCalledWith(
      'Current document could not be saved. The agent request was not sent.',
    )
    await harness.unmount()
  })

  it('tracks documents changed by apply_patch so cached drafts are bypassed', async () => {
    const onWorkspaceDocumentsModified = vi.fn()
    mocks.streamAgentMessage.mockImplementation(async ({ onEvent }: any) => {
      onEvent?.({
        type: 'tool_call',
        tool_call: {
          id: 91,
          session_id: 21,
          user_id: 1,
          tool_name: 'apply_patch',
          status: 'completed',
          input_data: {},
          output_data: { file_ops: [{ path: 'Docs/Article.md' }] },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:01.000Z',
        },
      })
      return { extra_data: {} }
    })
    const harness = await mountAgent({ onWorkspaceDocumentsModified })

    await act(async () => harness.getLatest().setAgentDraft(21, 'Improve the current article'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(21)
      await flushAsyncWork()
    })

    expect(Array.from(harness.getLatest().agentModifiedDocumentPaths)).toEqual(['Docs/Article.md'])
    expect(onWorkspaceDocumentsModified).toHaveBeenCalledWith(['Docs/Article.md'], 21)
    await harness.unmount()
  })

  it('publishes a created kitable path so the workspace tree refreshes immediately', async () => {
    const onWorkspaceDocumentsModified = vi.fn()
    const onTableMutated = vi.fn()
    mocks.streamAgentMessage.mockImplementation(async ({ onEvent }: any) => {
      onEvent?.({
        type: 'tool_call',
        tool_call: {
          id: 92,
          session_id: 22,
          user_id: 1,
          tool_name: 'data_table_create',
          status: 'completed',
          input_data: {},
          output_data: {
            path: 'Admissions/Low-threshold samples.kitable',
            document_id: 42,
            table_id: 7,
          },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:01.000Z',
        },
      })
      return { extra_data: {} }
    })
    const harness = await mountAgent({ onWorkspaceDocumentsModified, onTableMutated })

    await act(async () => harness.getLatest().setAgentDraft(22, 'Create a structured table'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(22)
      await flushAsyncWork()
    })

    expect(Array.from(harness.getLatest().agentModifiedDocumentPaths)).toEqual([
      'Admissions/Low-threshold samples.kitable',
    ])
    expect(onWorkspaceDocumentsModified).toHaveBeenCalledWith([
      'Admissions/Low-threshold samples.kitable',
    ], 22)
    expect(onTableMutated).toHaveBeenCalledTimes(1)
    await harness.unmount()
  })

  it('still refreshes the workspace tree when table creation omits its path', async () => {
    const onWorkspaceArtifactsSaved = vi.fn()
    mocks.streamAgentMessage.mockImplementation(async ({ onEvent }: any) => {
      onEvent?.({
        type: 'tool_call',
        tool_call: {
          id: 93,
          session_id: 23,
          user_id: 1,
          tool_name: 'data_table_create',
          status: 'completed',
          input_data: { title: 'Low-threshold samples' },
          output_data: { document_id: 42, table_id: 7 },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:01.000Z',
        },
      })
      return { extra_data: {} }
    })
    const harness = await mountAgent({ onWorkspaceArtifactsSaved })

    await act(async () => harness.getLatest().setAgentDraft(23, 'Create a structured table'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(23)
      await flushAsyncWork()
    })

    expect(onWorkspaceArtifactsSaved).toHaveBeenCalledWith(23)
    await harness.unmount()
  })

  it('forwards scoped Board context and streamed preview patches to the active Board bridge', async () => {
    const onWhiteboardPatch = vi.fn()
    const whiteboardContext = {
      type: 'whiteboard.context' as const,
      schema_version: 1 as const,
      board: { id: 'board:planning', path: 'Boards/Planning.kiboard', title: 'Planning' },
      scope: 'viewport' as const,
      viewport: { x: 0, y: 0, width: 800, height: 600, zoom: 1 },
      selected_element_ids: [],
      elements: [],
      clusters: [],
      recent_operations: [],
      source_refs: [],
    }
    const patch = {
      type: 'whiteboard.patch' as const,
      schema_version: 1 as const,
      summary: 'Add a node',
      operations: [{
        op: 'element.create' as const,
        element: {
          id: 'node-1',
          kind: 'mind_node' as const,
          bounds: { x: 20, y: 30, width: 140, height: 70 },
          text: 'Idea',
        },
      }],
    }
    mocks.streamAgentMessage.mockImplementation(async (options: any) => {
      expect(options.whiteboardContext).toEqual(whiteboardContext)
      options.onEvent?.({
        type: 'whiteboard_patch_provisional',
        provisional: true,
        whiteboard_patch: patch,
      })
      options.onEvent?.({
        type: 'whiteboard_patch',
        whiteboard_patch: patch,
      })
      return { extra_data: {} }
    })
    const harness = await mountAgent({
      getTurnContext: () => ({
        activeDocumentPath: 'Boards/Planning.kiboard',
        activeDataDocumentId: 0,
        activeDataTableId: 0,
        paneContext: 'whiteboard',
        whiteboardContext,
      }),
      onWhiteboardPatch,
    })

    await act(async () => harness.getLatest().setAgentDraft(24, 'Build a mind map'))
    await act(async () => {
      harness.getLatest().sendAiComposerMessage(24)
      await flushAsyncWork()
    })

    expect(onWhiteboardPatch).toHaveBeenNthCalledWith(1, {
      boardPath: 'Boards/Planning.kiboard',
      patch,
      provisional: true,
      sessionId: 24,
    })
    expect(onWhiteboardPatch).toHaveBeenNthCalledWith(2, {
      boardPath: 'Boards/Planning.kiboard',
      patch,
      provisional: false,
      sessionId: 24,
    })
    await harness.unmount()
  })
})
