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
  ensurePortalAccountSessionRestored: vi.fn(),
  isDesktopRuntime: vi.fn(),
  listWorkspaceDocuments: vi.fn(),
  notifyFromAgentEvent: vi.fn(),
  trackProductEventOnce: vi.fn(),
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

vi.mock('@/services/portalAccount', () => ({
  ensurePortalAccountSessionRestored: mocks.ensurePortalAccountSessionRestored,
}))

vi.mock('@/services/desktop', () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
  listWorkspaceDocuments: mocks.listWorkspaceDocuments,
}))

vi.mock('@/services/desktopNotifications', () => ({
  notifyFromAgentEvent: mocks.notifyFromAgentEvent,
}))

vi.mock('@/features/analytics/lib/productAnalytics', () => ({
  trackProductEventOnce: mocks.trackProductEventOnce,
}))

vi.mock('@/i18n', () => ({
  getCurrentLocale: () => 'en-US',
  getLanguageNameForLocale: () => 'English',
}))

function createHostedConsoleSettings() {
  return {
    providers: {
      kition_console: {
        enabled: true,
        label: 'Kition Cloud',
        baseUrl: '',
        apiKey: '',
        discoveredModels: ['gpt-5.5'],
      },
    },
    models: {
      activeProvider: 'kition_console',
      selectedModelByProvider: {
        kition_console: 'gpt-5.5',
      },
      preferredChatModel: '',
      preferredWritingModel: '',
    },
  } as any
}

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
      selectedModelByProvider: {
        openai: 'gpt-4.1',
      },
      preferredChatModel: '',
      preferredWritingModel: '',
    },
  } as any
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceAgent hosted console restore', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.listAgentSessions.mockResolvedValue({ items: [] })
    mocks.streamAgentMessage.mockResolvedValue({ extra_data: {} })
    mocks.isDesktopRuntime.mockReturnValue(true)
  })

  it('shows the user message immediately while portal restore is pending', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const settings = createHostedConsoleSettings()
    const onError = vi.fn()
    const onFeedback = vi.fn()
    let latest: any = null
    let resolveRestore: (value: unknown) => void = () => {}
    mocks.ensurePortalAccountSessionRestored.mockImplementation(() => new Promise((resolve) => {
      resolveRestore = resolve
    }))

    function Harness() {
      latest = useWorkspaceAgent({ settings, rootPath: '/test/workspace', onError, onFeedback })
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await act(async () => {
      latest.setAgentDraft(10, 'hello hosted console')
    })

    await act(async () => {
      latest.sendAiComposerMessage(10)
      await flushAsyncWork()
    })
    expect(mocks.ensurePortalAccountSessionRestored).toHaveBeenCalledTimes(1)
    expect(mocks.streamAgentMessage).not.toHaveBeenCalled()
    expect(latest.agentDrafts[10]).toBe('')
    expect(latest.agentMessages[10]).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello hosted console' }),
    ])

    await act(async () => {
      resolveRestore({ access_token: 'portal-token' })
      await flushAsyncWork()
    })
    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenLastCalledWith('')
    expect(mocks.trackProductEventOnce).toHaveBeenCalledWith('agent_first_request_started')
    expect(mocks.trackProductEventOnce).toHaveBeenCalledWith('agent_first_request_completed', { result: 'success' })

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('does not stream or insert an optimistic user message when portal restore fails', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const settings = createHostedConsoleSettings()
    const onError = vi.fn()
    const onFeedback = vi.fn()
    let latest: any = null
    mocks.ensurePortalAccountSessionRestored.mockRejectedValue(new Error('Kition Account could not be restored. Please try again.'))

    function Harness() {
      latest = useWorkspaceAgent({ settings, rootPath: '/test/workspace', onError, onFeedback })
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })
    await act(async () => {
      latest.setAgentDraft(11, 'hello hosted console')
    })
    await act(async () => {
      latest.sendAiComposerMessage(11)
      await flushAsyncWork()
    })

    expect(mocks.ensurePortalAccountSessionRestored).toHaveBeenCalledTimes(1)
    expect(mocks.streamAgentMessage).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Kition Account could not be restored. Please try again.')
    expect(latest.agentMessages[11]).toBeUndefined()

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('silences only the optional initial session load in web preview mode', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const onError = vi.fn()
    let latest: any = null
    mocks.listAgentSessions.mockRejectedValue(new Error('runtime unavailable'))

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError,
        onFeedback: vi.fn(),
        silentInitialSessionLoad: true,
      })
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
      await flushAsyncWork()
    })

    expect(mocks.listAgentSessions).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    await act(async () => {
      await latest.refreshAgentSessions()
      await flushAsyncWork()
    })
    expect(onError).toHaveBeenCalledWith('runtime unavailable')

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('waits for the hosted account callback before streaming and resumes once', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const settings = createHostedConsoleSettings()
    const ensureHostedAccountReady = vi.fn()
    let resolveReady: (ready: boolean) => void = () => {}
    ensureHostedAccountReady.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveReady = resolve
    }))
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings,
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        ensureHostedAccountReady,
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
    await act(async () => {
      latest.setAgentDraft(12, 'resume after sign-in')
    })
    await act(async () => {
      latest.sendAiComposerMessage(12)
      latest.sendAiComposerMessage(12)
      await flushAsyncWork()
    })

    expect(ensureHostedAccountReady).toHaveBeenCalledTimes(1)
    expect(mocks.ensurePortalAccountSessionRestored).not.toHaveBeenCalled()
    expect(mocks.streamAgentMessage).not.toHaveBeenCalled()
    expect(latest.agentMessages[12]).toEqual([
      expect.objectContaining({ role: 'user', content: 'resume after sign-in' }),
    ])

    await act(async () => {
      resolveReady(true)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.streamAgentMessage.mock.calls[0][0].content).toBe('resume after sign-in')

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('preserves the draft and does not stream when hosted sign-in is cancelled', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const settings = createHostedConsoleSettings()
    const ensureHostedAccountReady = vi.fn().mockResolvedValue(false)
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings,
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        ensureHostedAccountReady,
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
    await act(async () => {
      latest.setAgentDraft(13, 'keep this draft')
    })
    await act(async () => {
      latest.sendAiComposerMessage(13)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).not.toHaveBeenCalled()
    expect(latest.agentDrafts[13]).toBe('keep this draft')
    expect(latest.agentMessages[13]).toBeUndefined()

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('does not check the hosted account for bring-your-own providers', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const ensureHostedAccountReady = vi.fn().mockResolvedValue(true)
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        ensureHostedAccountReady,
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
    await act(async () => {
      latest.setAgentDraft(14, 'use my provider')
    })
    await act(async () => {
      latest.sendAiComposerMessage(14)
      await flushAsyncWork()
    })

    expect(ensureHostedAccountReady).not.toHaveBeenCalled()
    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('does not wait for workspace document discovery when a message has no mentions', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    mocks.listWorkspaceDocuments.mockImplementation(() => new Promise(() => {}))
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
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
    await act(async () => {
      latest.setAgentDraft(16, 'hello')
    })
    await act(async () => {
      latest.sendAiComposerMessage(16)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.streamAgentMessage.mock.calls[0][0].content).toBe('hello')

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('does not expose a hidden browser continuation when the runtime echoes it', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      args.onEvent?.({
        type: 'user_message',
        chat_message: {
          id: 1701,
          session_id: 17,
          user_id: 1,
          role: 'user',
          content: args.content,
          status: 'completed',
          created_at: '2026-07-26T00:00:00.000Z',
        },
      })
      return { extra_data: {} }
    })

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
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
    await act(async () => {
      latest.sendAgentContextAction(17, {
        content: 'Continue the original browser task.',
        browserAutoContinue: true,
      })
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      hideUserMessage: true,
    }))
    expect(latest.agentMessages[17]).toEqual([])

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('bounds repeated browser handoffs and preserves the original request', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    let eventId = 1800

    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      eventId += 1
      args.onEvent?.({
        type: 'agent_event',
        event: {
          id: eventId,
          session_id: 18,
          user_id: 1,
          event_type: 'browser.open_required',
          stage: 'browser',
          status: 'completed',
          label: 'Browser required',
          message: 'Use the current page.',
          data: {
            action: 'open_embedded_browser',
            adapter: 'youtube',
            command: 'extract-list',
            entity_type: 'video',
            host: 'youtube.com',
          },
          created_at: '2026-07-26T00:00:00.000Z',
        },
      })
      return { extra_data: {} }
    })

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
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

    const originalRequest = 'Open youtube.com and collect every loaded video card.'
    await act(async () => {
      latest.setAgentDraft(18, originalRequest)
    })
    await act(async () => {
      latest.sendAiComposerMessage(18)
      await flushAsyncWork()
    })
    expect(latest.agentEvents[18].at(-1)?.data).toMatchObject({
      client_auto_continue: true,
      client_auto_continue_attempt: 1,
      client_auto_continue_exhausted: false,
      client_original_request: originalRequest,
    })

    await act(async () => {
      latest.sendAgentContextAction(18, {
        content: 'Continue the current browser task.',
        browserAutoContinue: true,
        browserAutoContinueAttempt: 3,
        browserOriginalRequest: originalRequest,
      })
      await flushAsyncWork()
    })
    expect(latest.agentEvents[18].at(-1)?.data).toMatchObject({
      client_auto_continue: false,
      client_auto_continue_attempt: 3,
      client_auto_continue_exhausted: true,
      client_original_request: originalRequest,
    })

    await act(async () => {
      latest.sendAgentContextAction(18, {
        content: 'Report browser extraction as blocked.',
        browserAutoContinue: true,
        browserAutoContinueAttempt: 3,
        browserAutoContinueFinal: true,
        browserOriginalRequest: originalRequest,
      })
      await flushAsyncWork()
    })
    expect(latest.agentEvents[18].at(-1)?.data).not.toHaveProperty('client_auto_continue')

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('binds every turn to the current document without requiring an explicit mention', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        getTurnContext: () => ({
          activeDocumentPath: 'Docs/Current.md',
          activeDocumentFormat: 'markdown',
          activeDataDocumentId: 0,
          activeDataTableId: 0,
        }),
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
    await act(async () => {
      latest.setAgentDraft(15, 'What should I improve?')
    })
    await act(async () => {
      latest.sendAiComposerMessage(15)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)
    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      activeDocumentPath: 'Docs/Current.md',
      content: 'What should I improve?',
      promptContext: expect.stringContaining(
        'Read this exact path with document_read and analyze it before responding',
      ),
      saveMarkdown: false,
    }))

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  // Regression: agentBusySessionId used to be a single number, so a stuck
  // busy flag from session A made session B's Send silently no-op (no POST
  // and no toast — see the user report). Tracking per-session must let an
  // independent session fire concurrently while still blocking double-send
  // of the same session.
  it('allows a second session to send while another session is mid-stream', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const settings = createHostedConsoleSettings()
    const onError = vi.fn()
    const onFeedback = vi.fn()
    let latest: any = null
    // First call hangs (session A stays busy); second call resolves so
    // session B's send progresses normally.
    let releaseA: ((value: unknown) => void) | null = null
    mocks.ensurePortalAccountSessionRestored.mockResolvedValue({ access_token: 'token' })
    mocks.streamAgentMessage.mockImplementation((args: any) => {
      if (args.sessionId === 20) {
        return new Promise((resolve) => { releaseA = resolve })
      }
      return Promise.resolve({ extra_data: {} })
    })

    function Harness() {
      latest = useWorkspaceAgent({ settings, rootPath: '/test/workspace', onError, onFeedback })
      return null
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
    })

    // Kick off session A's send — it hangs in streamAgentMessage.
    await act(async () => {
      latest.setAgentDraft(20, 'long-running A')
      latest.setAgentDraft(21, 'follow-up on B')
    })
    await act(async () => {
      latest.sendAiComposerMessage(20)
      await flushAsyncWork()
    })
    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(1)
    expect(latest.agentBusySessions.has(20)).toBe(true)
    expect(latest.agentBusySessions.has(21)).toBe(false)

    // Now session B sends while A is still busy. Pre-fix this was a
    // silent skip; the fix lets B's call land normally.
    await act(async () => {
      latest.sendAiComposerMessage(21)
      await flushAsyncWork()
    })
    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(2)
    expect(mocks.streamAgentMessage.mock.calls[1][0].sessionId).toBe(21)

    // Session A still busy; B finished.
    expect(latest.agentBusySessions.has(20)).toBe(true)
    expect(latest.agentBusySessions.has(21)).toBe(false)

    // Drain A so the test doesn't leak a pending promise.
    await act(async () => {
      releaseA?.({ extra_data: {} })
      await flushAsyncWork()
    })

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })
})
