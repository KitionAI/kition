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
})
