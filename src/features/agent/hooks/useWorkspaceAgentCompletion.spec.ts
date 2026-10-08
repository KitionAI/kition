import { AgentStreamInterruptedError } from '@/api/agentStream'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  trackProductEventOnce: vi.fn(),
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
  trackProductEventOnce: mocks.trackProductEventOnce,
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

describe('useWorkspaceAgent unconfirmed completion', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.listAgentSessions.mockResolvedValue({ items: [] })
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.isDesktopRuntime.mockReturnValue(true)
  })

  it('keeps the artifact and partial answer, stops busy state, and does not record success', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const onError = vi.fn()
    let latest: ReturnType<typeof useWorkspaceAgent>
    const now = '2026-09-30T00:00:00Z'
    const artifact = { id: 9, session_id: 41, user_id: 1, kind: 'markdown', path: 'draft.md', created_at: now }
    mocks.streamAgentMessage.mockImplementation(async (options) => {
      options.onEvent({ type: 'user_message', chat_message: {
        id: 73, session_id: 41, user_id: 1, role: 'user', content: 'Write an article', status: 'completed', created_at: now,
      } })
      options.onEvent({ type: 'artifact', artifact })
      options.onEvent({ type: 'model_delta', delta: 'The saved draft covers' })
      throw new AgentStreamInterruptedError()
    })
    function Harness() {
      latest = useWorkspaceAgent({ settings: createOpenAISettings(), rootPath: '/test/workspace', onError, onFeedback: vi.fn() })
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => root.render(createElement(Harness)))
      await act(async () => latest.setAgentDraft(41, 'Write an article'))
      await act(async () => {
        latest.sendAiComposerMessage(41)
        await flushAsyncWork()
      })
      expect(mocks.streamAgentMessage).toHaveBeenCalledOnce()
      expect(mocks.trackProductEventOnce).not.toHaveBeenCalledWith('agent_first_request_completed', expect.anything())
      expect(latest!.agentArtifacts[41]).toContainEqual(artifact)
      expect(latest!.agentMessages[41]).toContainEqual(expect.objectContaining({
        role: 'assistant', content: 'The saved draft covers', status: 'interrupted',
      }))
      expect(latest!.agentEvents[41]).toContainEqual(expect.objectContaining({
        event_type: 'client.turn.interrupted', message_id: 73, status: 'pending',
      }))
      expect(latest!.agentBusySessions[41]).toBeFalsy()
      expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('before completion was confirmed'))
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
