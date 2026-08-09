/**
 * Focused AgentChatPanel specs with heavy dependencies mocked for speed.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession } from '@/api/agent'

// ── Mocks ────────────────────────────────────────────────────────────────────

// useDesktopSettings relies on Electron IPC — stub it out
vi.mock('@/features/settings/hooks/useDesktopSettings', () => ({
  useDesktopSettings: () => ({
    settings: {
      general: { language: 'en', debug: false },
    },
    update: vi.fn(),
  }),
}))

// resolveAgentImageURL uses workspaceFiles service
vi.mock('@/services/workspaceFiles', () => ({
  resolveAgentImageURL: (url: string) => url,
}))

// desktopSettings service loaded inside the hook
vi.mock('@/services/desktopSettings', () => ({
  createDefaultDesktopSettings: () => ({ general: { language: 'en', debug: false } }),
  loadDesktopSettings: () => Promise.resolve({ general: { language: 'en', debug: false } }),
  subscribeDesktopSettingsUpdated: () => () => {},
}))

// ── Import after mocks ────────────────────────────────────────────────────────

import { AgentChatPanel } from './AgentChatPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function unmount() {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
}

function makeSession(): AgentSession {
  return {
    id: 1,
    user_id: 1,
    title: 'Test session',
    status: 'idle',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeMinimalProps(extra: Record<string, unknown> = {}) {
  return {
    session: makeSession(),
    messages: [],
    toolCalls: [],
    events: [],
    draft: '',
    streamingText: '',
    artifacts: [],
    busy: false,
    modelOptions: [],
    selectedModelKey: 'gpt-4o',
    needsModelConfig: false,
    formatTime: () => '',
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onConfigureModel: vi.fn(),
    onModelChange: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...extra,
  } as any
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentChatPanel progressCard slot', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('renders without progressCard and does not crash', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps()))
    // The panel root should be present
    const panel = container.querySelector('.agent-chat-panel')
    expect(panel).not.toBeNull()
    // No sentinel present when prop is not passed
    expect(container.querySelector('[data-testid="pc-sentinel"]')).toBeNull()
  })

  it('renders progressCard when provided and positions it after messages container', async () => {
    const progressCard = createElement('div', {
      'data-testid': 'pc-sentinel',
      children: 'hi',
    })
    await mount(createElement(AgentChatPanel, makeMinimalProps({ progressCard })))

    // Sentinel is present
    const sentinel = container.querySelector('[data-testid="pc-sentinel"]')
    expect(sentinel).not.toBeNull()

    // Sentinel appears after the messages container in the DOM
    const messagesContainer = container.querySelector('.agent-chat-messages')
    const composer = container.querySelector('.agent-chat-composer')
    expect(messagesContainer).not.toBeNull()
    expect(composer).not.toBeNull()

    // Check DOM ordering: messages → sentinel → composer
    const all = Array.from(container.querySelectorAll('.agent-chat-messages, [data-testid="pc-sentinel"], .agent-chat-composer'))
    const messagesIdx = all.indexOf(messagesContainer as Element)
    const sentinelIdx = all.indexOf(sentinel as Element)
    const composerIdx = all.indexOf(composer as Element)

    expect(messagesIdx).toBeLessThan(sentinelIdx)
    expect(sentinelIdx).toBeLessThan(composerIdx)
  })
})

describe('AgentChatPanel composer controls', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('keeps web search and browser capability controls out of the composer', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const modelOption = {
      key: 'kition_console:gpt-test',
      providerKind: 'kition_console',
      providerLabel: 'Kition Cloud',
      modelName: 'gpt-test',
      runtimeModel: {
        provider_type: 'kition_console',
        provider_label: 'Kition Cloud',
        model_name: 'gpt-test',
        base_url: '',
        api_key: '',
        wire_api: 'responses',
      },
    }

    await mount(createElement(AgentChatPanel, makeMinimalProps({
      modelOptions: [modelOption],
      selectedModelKey: modelOption.key,
    })))

    const modelPicker = container.querySelector('.agent-ai-model-picker') as HTMLElement
    expect(modelPicker).not.toBeNull()
    expect(modelPicker.textContent).toContain('gpt-test')
    expect(modelPicker.textContent).not.toContain('Kition Cloud')
    await act(async () => {
      modelPicker.querySelector<HTMLButtonElement>('button')?.click()
      await Promise.resolve()
    })
    expect(modelPicker.textContent).not.toContain('Kition Cloud')
    expect(container.querySelector('.agent-ai-send')).not.toBeNull()
    expect(container.querySelector('[data-testid="agent-hosted-web-search-status"]')).toBeNull()
    expect(container.querySelector('.agent-ai-browser-toggle')).toBeNull()
  })
})

describe('AgentChatPanel changed files', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('opens the revision review when a modified file is clicked', async () => {
    const onOpenArtifact = vi.fn()
    const onReviewModifiedArtifact = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      onOpenArtifact,
      onReviewModifiedArtifact,
      toolCalls: [{
        id: 91,
        session_id: 1,
        user_id: 1,
        tool_name: 'apply_patch',
        status: 'completed',
        input_data: {},
        output_data: { file_ops: [{ path: 'Docs/Article.md' }] },
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:01.000Z',
      }],
    })))

    const changedFiles = container.querySelector<HTMLDetailsElement>('.agent-changed-files')
    expect(changedFiles?.open).toBe(false)
    await act(async () => {
      container.querySelector<HTMLElement>('.agent-changed-files-head')?.click()
    })
    expect(changedFiles?.open).toBe(true)

    const changedFile = container.querySelector<HTMLButtonElement>('.agent-changed-file')
    expect(changedFile).not.toBeNull()
    await act(async () => {
      changedFile?.click()
    })

    expect(onReviewModifiedArtifact).toHaveBeenCalledWith('Docs/Article.md')
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })

  it('shows a created kitable in the same bottom changed-files card as documents', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      toolCalls: [
        {
          id: 92,
          session_id: 1,
          user_id: 1,
          tool_name: 'apply_patch',
          status: 'completed',
          input_data: {},
          output_data: { file_ops: [{ path: 'Docs/Admissions guide.md' }] },
          created_at: '2026-08-04T00:00:00.000Z',
          updated_at: '2026-08-04T00:00:01.000Z',
        },
        {
          id: 93,
          session_id: 1,
          user_id: 1,
          tool_name: 'data_table_create',
          status: 'completed',
          input_data: {},
          output_data: { path: 'Admissions/Low-threshold samples.kitable' },
          created_at: '2026-08-04T00:00:02.000Z',
          updated_at: '2026-08-04T00:00:03.000Z',
        },
      ],
    })))

    const changedFiles = Array.from(container.querySelectorAll('.agent-changed-file-name'))
      .map((node) => node.textContent)
    const disclosure = container.querySelector<HTMLDetailsElement>('.agent-changed-files')

    expect(container.querySelector('.agent-changed-files-head')?.textContent).toContain('2 file(s) modified')
    expect(disclosure?.open).toBe(false)
    expect(changedFiles).toEqual([
      'Admissions guide.md',
      'Low-threshold samples.kitable',
    ])
  })
})

// Catches the regression the per-helper specs miss: AgentChatPanel
// could resolve PANE_SUGGESTIONS correctly but stop rendering the cards
// (e.g. someone wrapping the suggestion grid in a feature flag). vitest
// setup pins i18n to en-US, so the assertions also verify that the keys land in the
// bundled resources.
describe('AgentChatPanel empty-state per pane', () => {
  beforeEach(async () => {
    await unmount()
  })

  function getStarterLabels(): string[] {
    return Array.from(container.querySelectorAll('.agent-chat-suggestion-card span')).map(
      (n) => (n.textContent || '').trim(),
    )
  }

  it('document pane shows document suggestions', async () => {
    await mount(
      createElement(AgentChatPanel, makeMinimalProps({ paneContext: 'document' })),
    )
    const labels = getStarterLabels()
    expect(labels).toContain('Summarize this document')
    expect(labels).not.toContain('Email me on every new record')
    expect(labels).not.toContain('Add a site')
  })

  it('workflow pane shows workflow suggestions, not document suggestions', async () => {
    await mount(
      createElement(AgentChatPanel, makeMinimalProps({ paneContext: 'workflow' })),
    )
    const labels = getStarterLabels()
    expect(labels).toContain('Email me on every new record')
    expect(labels).toContain('Refine this workflow')
    expect(labels).not.toContain('Summarize this document')
  })

  it('browserSites pane shows discovery suggestions, not page-action suggestions', async () => {
    await mount(
      createElement(AgentChatPanel, makeMinimalProps({ paneContext: 'browserSites' })),
    )
    const labels = getStarterLabels()
    expect(labels).toContain('Add a site')
    expect(labels).toContain('Show connected')
                                                          
    // iter 14 split them deliberately.
    expect(labels).not.toContain('Summarise this page')
    expect(labels).not.toContain('Summarize this document')
  })

  it('gallery pane shows media-agnostic suggestions', async () => {
    await mount(
      createElement(AgentChatPanel, makeMinimalProps({ paneContext: 'gallery' })),
    )
    const labels = getStarterLabels()
    expect(labels).toContain('Describe each item')
    expect(labels).toContain('Pick the hero')
    expect(labels).not.toContain('Summarize this document')
  })

  it('suggestion card click fills the composer draft with the prompt', async () => {
    const onDraftChange = vi.fn()
    await mount(
      createElement(
        AgentChatPanel,
        makeMinimalProps({ paneContext: 'workflow', onDraftChange }),
      ),
    )
    const firstCard = container.querySelector('.agent-chat-suggestion-card') as HTMLButtonElement
    expect(firstCard).not.toBeNull()
    await act(async () => {
      firstCard.click()
      await Promise.resolve()
    })
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    const prompt = onDraftChange.mock.calls[0][0] as string
    // Verify it's the *workflow* pane's first suggestion prompt, not the
    // document fallback — proves the pane wiring at click time.
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).not.toMatch(/Summarize this document/)
  })

  // Without this, the suggestion cards are a trap: user clicks one, the
  // composer fills with text they didn't type, but the Send button is
  // disabled because there's no model. iter 22 replaces the suggestion
  // grid with a single "Configure a model" CTA in that state — the
  // ONLY thing the user can actually do.
  //
  // iter 28: parameterize across every pane. The CTA-swap logic is
  // pane-agnostic, but each pane has its own suggestion set, and a
  // regression that special-cases (say) workflow could silently leak
  // pane-specific suggestions back through. Cover all 6 panes
  // explicitly so one accidentally re-enabled pane fails its own
  // assertion.
  describe.each([
    { pane: 'document', leakedStarter: 'Summarize this document' },
    { pane: 'workflow', leakedStarter: 'Email me on every new record' },
    { pane: 'table', leakedStarter: 'Summarise this table' },
    { pane: 'browser', leakedStarter: 'Summarise this page' },
    { pane: 'browserSites', leakedStarter: 'Add a site' },
    { pane: 'gallery', leakedStarter: 'Describe each item' },
  ] as const)('needsModelConfig on pane $pane', ({ pane, leakedStarter }) => {
    it('hides the pane-specific suggestion and shows the Configure CTA instead', async () => {
      const onConfigureModel = vi.fn()
      const onDraftChange = vi.fn()
      await mount(
        createElement(
          AgentChatPanel,
          makeMinimalProps({
            paneContext: pane,
            needsModelConfig: true,
            onConfigureModel,
            onDraftChange,
          }),
        ),
      )
      const starterLabels = Array.from(
        container.querySelectorAll('.agent-chat-suggestion-card span'),
      ).map((n) => (n.textContent || '').trim())
      // The pane-specific suggestion must NOT render — we'd be back to
      // the trap of clicking a card that fills a draft the user
      // can't send.
      expect(starterLabels).not.toContain(leakedStarter)
      // The CTA must render with the en-US label.
      const cta = container.querySelector('[data-testid="agent-empty-configure-model"]') as HTMLButtonElement
      expect(cta).not.toBeNull()
      expect(cta.textContent).toContain('Configure a model')
      // Clicking it fires onConfigureModel, not onDraftChange.
      await act(async () => {
        cta.click()
        await Promise.resolve()
      })
      expect(onConfigureModel).toHaveBeenCalledTimes(1)
      expect(onDraftChange).not.toHaveBeenCalled()
    })
  })
})

describe('AgentChatPanel Kition Account readiness', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('replaces suggestions with sign-in while the hosted account is signed out', async () => {
    const onHostedAccountConnect = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'continue after sign-in',
      hostedAccountStatus: 'signed_out',
      onHostedAccountConnect,
    })))

    expect(container.querySelectorAll('.agent-chat-suggestion-card')).toHaveLength(1)
    expect(container.textContent).not.toContain('Summarize this document')
    const signIn = container.querySelector('[data-testid="agent-empty-kition-account"]') as HTMLButtonElement
    await act(async () => {
      signIn.click()
    })
    expect(onHostedAccountConnect).toHaveBeenCalledTimes(1)
    expect((container.querySelector('[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers cancellation while browser sign-in is pending', async () => {
    const onHostedAccountCancel = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      hostedAccountStatus: 'connecting',
      onHostedAccountCancel,
    })))

    const cancel = container.querySelector('[data-testid="agent-empty-kition-account"]') as HTMLButtonElement
    expect(cancel.textContent).toContain('Cancel sign-in')
    await act(async () => {
      cancel.click()
    })
    expect(onHostedAccountCancel).toHaveBeenCalledTimes(1)
  })

  it('shows normal suggestions when the hosted account is ready', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      hostedAccountStatus: 'ready',
    })))

    expect(container.textContent).toContain('Summarize this document')
    expect(container.querySelector('[data-testid="agent-empty-kition-account"]')).toBeNull()
  })

  it('keeps hosted models usable while credits are low', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'use remaining credits',
      hostedAccountStatus: 'credits_low',
    })))

    expect(container.textContent).toContain('Summarize this document')
    expect(container.querySelector('[data-testid="agent-empty-kition-account"]')).toBeNull()
    expect((container.querySelector('[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('blocks hosted sends and opens billing when credits are empty', async () => {
    const onHostedAccountBilling = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'cannot send yet',
      hostedAccountStatus: 'credits_empty',
      onHostedAccountBilling,
    })))

    const topup = container.querySelector('[data-testid="agent-empty-kition-account"]') as HTMLButtonElement
    expect(topup.textContent).toContain('Top up credits')
    await act(async () => {
      topup.click()
    })
    expect(onHostedAccountBilling).toHaveBeenCalledTimes(1)
    expect((container.querySelector('[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers sign-in again for an expired account', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      hostedAccountStatus: 'expired',
      onHostedAccountConnect: vi.fn(),
    })))

    expect(container.querySelector('[data-testid="agent-empty-kition-account"]')?.textContent).toContain('Sign in again')
  })

  it('disables account and send actions while readiness is loading', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'wait for readiness',
      hostedAccountStatus: 'loading',
    })))

    expect((container.querySelector('[data-testid="agent-empty-kition-account"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-testid="agent-composer-kition-account"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AgentChatPanel document references', () => {
  beforeEach(async () => {
    await unmount()
  })

  const longPath = 'Getting Started/Guides/Product Content/Product Content Studio.kitable'

  it('hides mention tokens and shows only the removable file name', async () => {
    const onDraftChange = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: `Analyze this document\n@{${longPath}}`,
      mentionableDocuments: [{
        kind: 'file',
        path: longPath,
        name: 'Product Content Studio.kitable',
        title: 'Product Content Studio',
        format: 'data',
      }],
      onDraftChange,
    })))

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Analyze this document')
    expect(container.textContent).toContain('Product Content Studio.kitable')
    expect(container.textContent).not.toContain('@{')
    expect(container.textContent).not.toContain('Getting Started/Guides')

    const remove = container.querySelector(
      '[aria-label="Remove Product Content Studio.kitable"]',
    ) as HTMLButtonElement
    await act(async () => {
      remove.click()
    })
    expect(onDraftChange).toHaveBeenCalledWith('Analyze this document')
  })

  it('collapses multiple references into a select-style control', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'Compare these\n@{Docs/Plan.md} @{Notes/Todo.md}',
      mentionableDocuments: [
        { kind: 'file', path: 'Docs/Plan.md', name: 'Plan.md', title: 'Plan', format: 'markdown' },
        { kind: 'file', path: 'Notes/Todo.md', name: 'Todo.md', title: 'Todo', format: 'markdown' },
      ],
    })))

    const select = container.querySelector(
      '[data-testid="agent-document-reference-select"]',
    ) as HTMLElement
    expect(select).not.toBeNull()
    expect(select.textContent).toContain('2 files')
  })

  it('renders sent messages without raw mention syntax or folder paths', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      messages: [{
        id: 41,
        session_id: 1,
        user_id: 1,
        role: 'user',
        content: `Summarize it\n@{${longPath}}`,
        status: 'completed',
        created_at: new Date().toISOString(),
      }],
    })))

    const userMessage = container.querySelector('[data-role="user"]') as HTMLElement
    expect(userMessage.textContent).toContain('Summarize it')
    expect(userMessage.textContent).toContain('Product Content Studio.kitable')
    expect(userMessage.textContent).not.toContain('@{')
    expect(userMessage.textContent).not.toContain('Getting Started/Guides')
  })
})
