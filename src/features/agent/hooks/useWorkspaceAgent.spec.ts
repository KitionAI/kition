import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  deleteAgentSession: vi.fn(),
  listAgentSessionEvents: vi.fn(),
  listAgentSessions: vi.fn(),
  streamAgentMessage: vi.fn(),
  ensurePortalAccountSessionRestored: vi.fn(),
  isDesktopRuntime: vi.fn(),
  listWorkspaceDocuments: vi.fn(),
  importWorkspaceFileIntoDataTable: vi.fn(),
  notifyFromAgentEvent: vi.fn(),
  trackProductEventOnce: vi.fn(),
}))

vi.mock('@/api/agent', () => ({
  createAgentSession: mocks.createAgentSession,
  deleteAgentSession: mocks.deleteAgentSession,
  listAgentSessionEvents: mocks.listAgentSessionEvents,
  listAgentSessions: mocks.listAgentSessions,
  streamAgentMessage: mocks.streamAgentMessage,
}))

vi.mock('@/services/portalAccount', () => ({
  ensurePortalAccountSessionRestored: mocks.ensurePortalAccountSessionRestored,
}))

vi.mock('@/services/desktop', () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
  listWorkspaceDocuments: mocks.listWorkspaceDocuments,
}))

vi.mock('@/features/table/lib/importWorkspaceFileIntoDataTable', () => ({
  importWorkspaceFileIntoDataTable: mocks.importWorkspaceFileIntoDataTable,
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
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('useWorkspaceAgent hosted console restore', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.listAgentSessions.mockResolvedValue({ items: [] })
    mocks.listAgentSessionEvents.mockResolvedValue({ items: [], next_after: 0 })
    mocks.streamAgentMessage.mockResolvedValue(undefined)
    mocks.importWorkspaceFileIntoDataTable.mockResolvedValue({
      created: 0,
      fieldCount: 0,
      inferredFields: [],
    })
    mocks.isDesktopRuntime.mockReturnValue(true)
  })

  it('resumes a blocked shell command with the selected approval decision', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
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
    const root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))

    await act(async () => {
      latest.respondToAgentShellApproval(41, {
        call_id: 'call_21',
        kind: 'shell.approval',
        command: 'git push',
        reason: '',
        requires: 'approval',
        decision: 'prompt',
        suggested: { prefix: ['git'], decision: 'allow' },
      }, 'allow_once')
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 41,
      hideUserMessage: true,
      shellApproval: {
        call_id: 'call_21',
        decision: 'allow_once',
      },
    }))
    expect(mocks.streamAgentMessage.mock.calls[0][0].content).toContain(
      'Retry this exact command now: git push',
    )

    await act(async () => root.unmount())
    container.remove()
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
    expect(latest.agentPendingUserText[10]).toBe('hello hosted console')

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

  it('sends session-scoped local analysis sources with the agent turn', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
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
    const root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      latest.addAgentLocalSource(41, {
        id: 'source-project',
        label: 'project',
        root_path: '/example/project',
        access: 'read',
      })
      latest.setAgentDraft(41, 'Analyze the selected folder')
    })
    await act(async () => {
      latest.sendAiComposerMessage(41)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 41,
      localSources: [{
        id: 'source-project',
        label: 'project',
        root_path: '/example/project',
        access: 'read',
      }],
    }))

    await act(async () => root.unmount())
    container.remove()
  })

  it('can send a newly consented folder on the same turn before state rerenders', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    const source = {
      id: 'source-project',
      label: 'project',
      root_path: '/example/project',
      access: 'read',
    }

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
    const root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
    await act(async () => latest.setAgentDraft(42, 'Analyze ../project'))
    await act(async () => {
      latest.sendAiComposerMessage(42, [source])
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 42,
      localSources: [source],
    }))

    await act(async () => root.unmount())
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
    expect(latest.agentPendingUserText[11]).toBeUndefined()

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

  it('keeps a newly created session when an older list request resolves later', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    let resolveSessions: (value: unknown) => void = () => {}
    const session = {
      id: 42,
      user_id: 1,
      title: 'New chat',
      status: 'idle',
      created_at: '2026-08-23T00:00:00.000Z',
      updated_at: '2026-08-23T00:00:00.000Z',
    }
    mocks.listAgentSessions.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSessions = resolve
    }))
    mocks.createAgentSession.mockResolvedValue(session)

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '',
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

    let refreshPromise: Promise<void> | undefined
    await act(async () => {
      refreshPromise = latest.refreshAgentSessions()
      await flushAsyncWork()
    })
    await act(async () => {
      await latest.createNewAgentChat({ focusTab: true })
      await flushAsyncWork()
    })
    await act(async () => {
      resolveSessions({ items: [] })
      await refreshPromise
      await flushAsyncWork()
    })

    expect(latest.agentSessions).toEqual([session])
    expect(latest.pendingFocusedSessionId).toBe(session.id)

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
    expect(latest.agentPendingUserText[12]).toBe('resume after sign-in')

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
    expect(latest.agentPendingUserText[13]).toBeUndefined()

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

  it('retries a send while the stopped turn finishes releasing its session', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const busy = () => Object.assign(
      new Error('{"code":409,"message":"This session is still answering. Wait for the reply or stop it first."}'),
      { status: 409 },
    )
    mocks.streamAgentMessage
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    let latest: any = null

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError,
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
      latest.setAgentDraft(16, 'send again')
    })
    await act(async () => {
      latest.sendAiComposerMessage(16)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledTimes(3)
    for (const [request] of mocks.streamAgentMessage.mock.calls) {
      expect(request.content).toBe('send again')
    }
    expect(onError.mock.calls.filter(([message]) => message)).toEqual([])
    expect(latest.agentPendingUserText[16]).toBeUndefined()

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it.each(['', 'Create a launch illustration.'])('forwards a typed image intent with draft %j from a visible composer turn', async (draft) => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    const imageGenerationIntent = {
      type: 'image_generation.intent',
      schema_version: 1,
      request_id: 'image-request-visible-1',
      operation: 'generate',
      instruction: 'Create a launch illustration.',
      locale: 'en-US',
      aspect_ratio: '16:9',
      quality: 'medium',
      resolution: '1K',
      variants: 1,
      text_mode: 'no_text',
      reference_paths: [],
      surface: 'document',
      target: {
        type: 'image.target.document',
        document_path: 'Docs/Launch.md',
      },
      placement_preference: 'review',
      client_capability_version: 1,
    }
    const variantCall = {
      seq: 3, at: 3, type: 'tool/call', callId: 'img_abc_0', name: 'image_generation',
      arguments: { request_id: imageGenerationIntent.request_id, variant_index: 0, variant_count: 1 },
    }
    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      for (const event of [
        { seq: 1, at: 1, type: 'turn/start', turn: 1 },
        { seq: 2, at: 2, type: 'user/message', content: [{ type: 'text', text: imageGenerationIntent.instruction }], source: { kind: 'user' } },
        variantCall,
      ]) {
        args.onNotification?.({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'agent:25', event } })
      }
    })

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        getTurnContext: () => ({
          activeDocumentPath: 'Docs/Launch.md',
          paneContext: 'document',
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
      latest.setAgentDraft(25, draft)
    })
    await act(async () => {
      latest.sendAiComposerMessage(25, undefined, imageGenerationIntent)
      await flushAsyncWork()
    })

    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: imageGenerationIntent.instruction,
      hideUserMessage: false,
      imageGenerationIntent,
      paneContext: 'document',
    }))
    expect(latest.agentSessionViews[25].turns[0].toolRuns[0]).toMatchObject({
      callId: 'img_abc_0', name: 'image_generation', status: 'running',
    })

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
          markdownImageInsertionContext: {
            documentPath: 'Docs/Current.md',
            cursorOffset: 20,
            preferredOffset: 30,
            preferredLine: 6,
            strategy: 'nearest-blank-line',
            anchorBefore: 'before-anchor',
            anchorAfter: 'after-anchor',
          },
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
    expect(mocks.streamAgentMessage.mock.calls[0][0].promptContext).toContain(
      'order all hunks from top to bottom',
    )
    expect(mocks.streamAgentMessage.mock.calls[0][0].promptContext).toContain(
      'Preferred safe image insertion: line 6, offset 30',
    )
    expect(mocks.streamAgentMessage.mock.calls[0][0].promptContext).toContain(
      'before-anchor',
    )

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })

  it('keeps a removed current document detached until the session explicitly reattaches it', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    const prepareActiveDocument = vi.fn().mockResolvedValue(true)

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        prepareActiveDocument,
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
    const root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
    await act(async () => {
      latest.removeAgentDocumentContext(19, 'Docs/Current.md')
      latest.setAgentDraft(19, 'Answer without the open document')
    })
    await act(async () => {
      latest.sendAiComposerMessage(19)
      await flushAsyncWork()
    })

    expect(latest.resolveAgentDocumentContext(19, 'Docs/Current.md')).toBe('')
    expect(mocks.streamAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      activeDocumentPath: '',
      content: 'Answer without the open document',
      saveMarkdown: true,
    }))
    expect(mocks.streamAgentMessage.mock.calls.at(-1)?.[0].promptContext).not.toContain(
      'Current workspace document for this turn',
    )
    expect(prepareActiveDocument).not.toHaveBeenCalled()

    await act(async () => {
      latest.addAgentDocumentContext(19, 'Docs/Current.md')
      latest.setAgentDraft(19, 'Use the document again')
    })
    await act(async () => {
      latest.sendAiComposerMessage(19)
      await flushAsyncWork()
    })

    expect(latest.resolveAgentDocumentContext(19, 'Docs/Current.md')).toBe('Docs/Current.md')
    expect(mocks.streamAgentMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      activeDocumentPath: 'Docs/Current.md',
      content: 'Use the document again',
      saveMarkdown: false,
    }))
    expect(prepareActiveDocument).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    container.remove()
  })

  it('retains manually attached document contexts after sending a turn', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    let latest: any = null
    mocks.listWorkspaceDocuments.mockResolvedValue({
      items: [
        { type: 'file', path: 'Docs/Current.md', name: 'Current.md', format: 'markdown' },
        { type: 'file', path: 'Notes/Brief.md', name: 'Brief.md', format: 'markdown' },
      ],
    })

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
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
      await flushAsyncWork()
    })
    await act(async () => {
      latest.addAgentDocumentContext(21, 'Notes/Brief.md', 'Docs/Current.md')
      latest.setAgentDraft(21, 'Compare these documents')
    })
    await act(async () => {
      latest.sendAiComposerMessage(21)
      await flushAsyncWork()
    })

    expect(latest.resolveAgentDocumentContexts(21, 'Docs/Current.md')).toEqual([
      'Docs/Current.md',
      'Notes/Brief.md',
    ])
    expect(latest.agentDrafts[21] || '').toBe('')
    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      activeDocumentPath: 'Docs/Current.md',
      content: 'Compare these documents',
      promptContext: expect.stringContaining('Notes/Brief.md'),
    }))

    await act(async () => root.unmount())
    container.remove()
  })

  it('imports a referenced spreadsheet deterministically before the table agent responds', async () => {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const onTableMutated = vi.fn()
    let latest: any = null
    mocks.listWorkspaceDocuments.mockResolvedValue({
      items: [{
        type: 'file',
        path: 'Reports/issues.xlsx',
        name: 'issues.xlsx',
        format: 'xlsx',
      }],
    })
    mocks.importWorkspaceFileIntoDataTable.mockResolvedValue({
      created: 7247,
      fieldCount: 16,
      inferredFields: [
        { title: 'Owner', type: 'text' },
        { title: 'Hours', type: 'number' },
      ],
    })

    function Harness() {
      latest = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        onTableMutated,
        getTurnContext: () => ({
          activeDocumentPath: 'Issues.kitable',
          activeDocumentFormat: 'data',
          activeDataDocumentId: 12,
          activeDataTableId: 34,
          paneContext: 'table',
          taskMode: 'table',
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
      await flushAsyncWork()
    })
    await act(async () => {
      latest.setAgentDraft(16, 'Import @{Reports/issues.xlsx} into this table')
    })
    await act(async () => {
      latest.sendAiComposerMessage(16)
      await flushAsyncWork()
    })

    expect(mocks.importWorkspaceFileIntoDataTable).toHaveBeenCalledWith({
      documentId: 12,
      path: 'Reports/issues.xlsx',
      tableId: 34,
    })
    expect(mocks.streamAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'preview',
      attachmentPaths: [],
      promptContext: expect.stringContaining('Imported records: 7247'),
    }))
    expect(onTableMutated).toHaveBeenCalledTimes(1)

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
      return Promise.resolve(undefined)
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
      releaseA?.(undefined)
      await flushAsyncWork()
    })

    await act(async () => {
      root?.unmount()
    })
    container.remove()
  })
})

describe('useWorkspaceAgent session events', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    mocks.listWorkspaceDocuments.mockResolvedValue({ items: [] })
    mocks.listAgentSessions.mockResolvedValue({ items: [] })
    mocks.listAgentSessionEvents.mockResolvedValue({ items: [], next_after: 0 })
    mocks.isDesktopRuntime.mockReturnValue(true)
  })

  const sessionId = 'agent:30'
  const event = (body: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: body } })
  const status = (value: string) => ({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: value } })
  const frame = (body: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'agent/assistant-stream', params: { sessionId, frame: body } })
  const patch = {
    type: 'whiteboard.patch',
    schema_version: 1,
    summary: 'Add a node',
    operations: [{ op: 'element.create', element: { id: 'n1', kind: 'mind_node', bounds: { x: 0, y: 0, width: 10, height: 10 }, text: 'Idea' } }],
  }

  /** A turn that writes a document, previews and proposes a board patch, and answers. */
  function turnNotifications() {
    let seq = 0
    const logged = (body: Record<string, unknown>) => {
      seq += 1
      return event({ seq, at: seq, ...body })
    }
    return [
      status('running'),
      logged({ type: 'turn/start', turn: 1 }),
      logged({ type: 'step/start', turn: 1, step: 1 }),
      logged({ type: 'user/message', content: [{ type: 'text', text: 'Plan it' }], source: { kind: 'user' } }),
      frame({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }),
      frame({ type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'w1', name: 'whiteboard_propose_patch', argumentsDelta: JSON.stringify(patch) } }),
      logged({ type: 'assistant/message', content: '', stopReason: 'tool_calls', model: 'm' }),
      frame({ type: 'end', attemptId: 'a1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } }),
      logged({ type: 'tool/call', callId: 'd1', name: 'document_write', arguments: { path: 'Notes/plan.md' } }),
      logged({ type: 'tool/result', callId: 'd1', name: 'document_write', isError: false, content: [], value: { name: 'document_write', summary: 'Updated', output: { path: 'Notes/plan.md' } } }),
      logged({ type: 'deliverables/presented', turn: 1, callId: 'd1', files: [{ path: 'Notes/plan.md' }] }),
      logged({ type: 'tool/call', callId: 'w1', name: 'whiteboard_propose_patch', arguments: {} }),
      logged({ type: 'tool/result', callId: 'w1', name: 'whiteboard_propose_patch', isError: false, content: [], value: { name: 'whiteboard_propose_patch', summary: 'Proposed', output: {} }, meta: { kind: 'whiteboard.patch', patch } }),
      logged({ type: 'tool/call', callId: 't1', name: 'data_table_add_records', arguments: {} }),
      logged({ type: 'tool/result', callId: 't1', name: 'data_table_add_records', isError: false, content: [], value: { name: 'data_table_add_records', summary: 'Wrote', output: { created: 1 } } }),
      logged({ type: 'step/start', turn: 1, step: 2 }),
      frame({ type: 'start', attemptId: 'a2', revision: 4, turn: 1, step: 2 }),
      frame({ type: 'chunk', attemptId: 'a2', revision: 5, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: 'Done.' } }),
      logged({ type: 'assistant/message', content: 'Done.', stopReason: 'stop', model: 'm' }),
      frame({ type: 'end', attemptId: 'a2', revision: 6, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 13 } }),
      logged({ type: 'turn/end', turn: 1, reason: 'completed' }),
      status('idle'),
    ]
  }

  async function mountHook(options: Record<string, unknown> = {}) {
    const { useWorkspaceAgent } = await import('./useWorkspaceAgent')
    const latest: { current: any } = { current: null }
    function Harness() {
      latest.current = useWorkspaceAgent({
        settings: createOpenAISettings(),
        rootPath: '/test/workspace',
        onError: vi.fn(),
        onFeedback: vi.fn(),
        ...options,
      } as any)
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
    return {
      latest,
      unmount: async () => {
        await act(async () => root.unmount())
        container.remove()
      },
    }
  }

  async function send(latest: { current: any }, id: number, text: string) {
    await act(async () => latest.current.setAgentDraft(id, text))
    await act(async () => {
      latest.current.sendAiComposerMessage(id)
      await flushAsyncWork()
    })
  }

  it('builds the turn from notifications and runs each effect once', async () => {
    const callbacks = {
      onWorkspaceDocumentsModified: vi.fn(),
      onWorkspaceArtifactsSaved: vi.fn(),
      onTableMutated: vi.fn(),
      onWhiteboardPatch: vi.fn(),
      onWhiteboardPatchCancelled: vi.fn(),
      getTurnContext: () => ({ paneContext: 'whiteboard', whiteboardContext: { board: { path: 'Boards/a.kiboard' } } }),
    }
    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      for (const notification of turnNotifications()) args.onNotification(notification)
    })
    const { latest, unmount } = await mountHook(callbacks)
    await send(latest, 30, 'Plan it')

    const view = latest.current.agentSessionViews[30]
    expect(view.cursor).toBe(14)
    expect(view.running).toBe(false)
    expect(view.turns[0]).toMatchObject({ userText: 'Plan it', reply: 'Done.', end: { reason: 'completed' } })
    expect(latest.current.agentPendingUserText[30]).toBeUndefined()
    expect(callbacks.onWorkspaceDocumentsModified).toHaveBeenCalledExactlyOnceWith(['Notes/plan.md'], 30)
    expect(latest.current.agentModifiedDocumentPaths.has('Notes/plan.md')).toBe(true)
    expect(callbacks.onWorkspaceArtifactsSaved).toHaveBeenCalledExactlyOnceWith(30)
    expect(callbacks.onWhiteboardPatch.mock.calls.map(([input]) => input.provisional)).toEqual([true, false])
    expect(callbacks.onWhiteboardPatch).toHaveBeenLastCalledWith({ boardPath: 'Boards/a.kiboard', patch, provisional: false, sessionId: 30 })
    expect(callbacks.onWhiteboardPatchCancelled).not.toHaveBeenCalled()
    expect(callbacks.onTableMutated).toHaveBeenCalledTimes(1)
    expect(mocks.listWorkspaceDocuments).toHaveBeenCalled()
    expect(mocks.listAgentSessions).toHaveBeenCalled()
    expect(mocks.notifyFromAgentEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'task.completed' }))
    // The log is read before the send and again after the stream ends.
    expect(mocks.listAgentSessionEvents.mock.calls.map(([id, after]) => [id, after])).toEqual([[30, 0], [30, 14]])
    await unmount()
  })

  describe('when the stream fails after a canvas patch', () => {
    const whiteboardTurn = () => ({
      onWhiteboardPatch: vi.fn(),
      onWhiteboardPatchCancelled: vi.fn(),
      getTurnContext: () => ({ paneContext: 'whiteboard', whiteboardContext: { board: { path: 'Boards/a.kiboard' } } }),
    })
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
    // Index 12 is the `tool/result` carrying the final patch; index 5 the
    // chunk that completes the provisional preview.
    const throwAfter = (count: number, error: () => Error) => async (args: any) => {
      for (const notification of turnNotifications().slice(0, count)) args.onNotification(notification)
      throw error()
    }

    it.each([
      ['an error', () => new Error('boom')],
      ['Stop', abortError],
    ])('keeps a final patch waiting for Accept after %s', async (_label, error) => {
      const callbacks = whiteboardTurn()
      mocks.streamAgentMessage.mockImplementation(throwAfter(13, error))
      const { latest, unmount } = await mountHook(callbacks)
      await send(latest, 30, 'Plan it')
      expect(callbacks.onWhiteboardPatch.mock.calls.map(([input]) => input.provisional)).toEqual([true, false])
      expect(callbacks.onWhiteboardPatchCancelled).not.toHaveBeenCalled()
      await unmount()
    })

    it.each([
      ['an error', () => new Error('boom')],
      ['Stop', abortError],
    ])('cancels an open provisional preview after %s', async (_label, error) => {
      const callbacks = whiteboardTurn()
      mocks.streamAgentMessage.mockImplementation(throwAfter(6, error))
      const { latest, unmount } = await mountHook(callbacks)
      await send(latest, 30, 'Plan it')
      expect(callbacks.onWhiteboardPatch.mock.calls.map(([input]) => input.provisional)).toEqual([true])
      expect(callbacks.onWhiteboardPatchCancelled).toHaveBeenCalledExactlyOnceWith({ boardPath: 'Boards/a.kiboard', sessionId: 30 })
      await unmount()
    })
  })

  describe('the log read after Stop', () => {
    const stopMidTurn = async (args: any) => {
      for (const notification of turnNotifications().slice(0, 4)) args.onNotification(notification)
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const waitPastResync = () => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
    })

    it('runs a second later while the session is open', async () => {
      mocks.streamAgentMessage.mockImplementation(stopMidTurn)
      const { latest, unmount } = await mountHook()
      await send(latest, 30, 'Plan it')
      const reads = mocks.listAgentSessionEvents.mock.calls.length
      await waitPastResync()
      expect(mocks.listAgentSessionEvents.mock.calls.length).toBe(reads + 1)
      await unmount()
    })

    it('is dropped when the session is deleted', async () => {
      mocks.streamAgentMessage.mockImplementation(stopMidTurn)
      mocks.deleteAgentSession.mockResolvedValue(undefined)
      const { latest, unmount } = await mountHook()
      await send(latest, 30, 'Plan it')
      await act(async () => latest.current.deleteAgentChat(30))
      const reads = mocks.listAgentSessionEvents.mock.calls.length
      await waitPastResync()
      expect(mocks.listAgentSessionEvents.mock.calls.length).toBe(reads)
      expect(latest.current.agentSessionViews[30]).toBeUndefined()
      await unmount()
    })

    it('is dropped on unmount', async () => {
      mocks.streamAgentMessage.mockImplementation(stopMidTurn)
      const { latest, unmount } = await mountHook()
      await send(latest, 30, 'Plan it')
      await unmount()
      const reads = mocks.listAgentSessionEvents.mock.calls.length
      await waitPastResync()
      expect(mocks.listAgentSessionEvents.mock.calls.length).toBe(reads)
    })
  })

  it('shows completion as unknown when the stream ends before idle', async () => {
    const { AgentStreamInterruptedError } = await import('@/api/agentStream')
    const onError = vi.fn()
    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      for (const notification of turnNotifications().slice(0, 4)) args.onNotification(notification)
      args.onNotification(frame({ type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 }))
      args.onNotification(frame({ type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'Half' } }))
      throw new AgentStreamInterruptedError()
    })
    const { latest, unmount } = await mountHook({ onError })
    await send(latest, 30, 'Plan it')

    const turn = latest.current.agentSessionViews[30].turns[0]
    expect(turn).toMatchObject({ interrupted: true, partialReply: 'Half' })
    expect(turn.end).toBeUndefined()
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('connection ended'))
    expect(latest.current.agentBusySessions.has(30)).toBe(false)
    await unmount()
  })

  it('reads the log when a live event skips past the cursor', async () => {
    mocks.streamAgentMessage.mockImplementation(async (args: any) => {
      args.onNotification(event({ seq: 3, at: 3, type: 'turn/start', turn: 2 }))
    })
    const { latest, unmount } = await mountHook()
    await send(latest, 30, 'Again')
    expect(latest.current.agentSessionViews[30]?.cursor ?? 0).toBe(0)
    // Once before the send, once for the gap (joined by the read after the stream).
    expect(mocks.listAgentSessionEvents.mock.calls.length).toBeGreaterThanOrEqual(2)
    await unmount()
  })

  it('loads a session from its log when it is opened', async () => {
    mocks.listAgentSessionEvents.mockResolvedValueOnce({
      items: [
        { seq: 1, at: 1, type: 'turn/start', turn: 1 },
        { seq: 2, at: 2, type: 'user/message', content: [{ type: 'text', text: 'Hi' }], source: { kind: 'user' } },
        { seq: 3, at: 3, type: 'turn/end', turn: 1, reason: 'completed' },
      ],
      next_after: 3,
    })
    const { latest, unmount } = await mountHook()
    await act(async () => {
      await latest.current.openAgentSession({ id: 31 })
    })
    expect(latest.current.agentSessionViews[31].turns[0].userText).toBe('Hi')
    expect(mocks.listAgentSessionEvents).toHaveBeenCalledWith(31, 0)
    await unmount()
  })
})
