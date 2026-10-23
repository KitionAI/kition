/**
 * Focused AgentChatPanel specs with heavy dependencies mocked for speed.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSession } from '@/api/agent'
import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import { applySessionEvent, emptyAgentSessionView } from '../lib/agentSessionView'

// ── Mocks ────────────────────────────────────────────────────────────────────

// useDesktopSettings relies on the desktop bridge — stub it out
vi.mock('@/features/settings/hooks/useDesktopSettings', () => ({
  useDesktopSettings: () => ({
    settings: {
      general: { language: 'en', debug: false },
    },
    update: vi.fn(),
  }),
}))

// resolveAgentImageURL uses workspaceFiles service
vi.mock('@/services/workspaceFiles', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/workspaceFiles')>(),
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

async function render(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root?.render(node)
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeMinimalProps(extra: Record<string, unknown> = {}) {
  return {
    session: makeSession(),
    view: emptyAgentSessionView(),
    draft: '',
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

type Body = { type: string } & Record<string, unknown>

/** A one-turn session view: the user's `text`, then `bodies`, numbered from seq 0. */
function viewOf(text: string, bodies: Body[] = []) {
  const list = [
    { type: 'turn/start', turn: 1 },
    { type: 'step/start', turn: 1, step: 1 },
    { type: 'user/message', content: [{ type: 'text', text }], source: { kind: 'user' } },
    ...bodies,
  ].map((body, index) => ({ seq: index, at: Date.parse('2026-08-10T00:00:00.000Z') + index, ...body }) as AgentSessionEventsSessionEvent)
  return list.reduce(applySessionEvent, emptyAgentSessionView())
}

const ran = (callId: string, name: string, args: unknown, output: unknown): Body[] => [
  { type: 'tool/call', callId, name, arguments: args },
  { type: 'tool/result', callId, name, isError: false, content: [], value: { name, summary: 'Done', output } },
]

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

  it('sends with Enter and keeps Shift+Enter available for a newline', async () => {
    const onSend = vi.fn()
    const onDraftChange = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'First line',
      onDraftChange,
      onSend,
    })))

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    let shiftEnterAllowed = false
    await act(async () => {
      shiftEnterAllowed = textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }))
    })

    expect(shiftEnterAllowed).toBe(false)
    expect(onDraftChange).toHaveBeenCalledWith('First line\n')
    expect(onSend).not.toHaveBeenCalled()

    let enterAllowed = true
    await act(async () => {
      enterAllowed = textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })

    expect(enterAllowed).toBe(false)
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('keeps web search capability controls out of the composer', async () => {
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
  })

  it('keeps the write target and local folders in the input area', async () => {
    const onRemoveDocumentContext = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      documentContextPaths: ['Campaigns/X launch.md'],
      onRemoveDocumentContext,
      localSources: [{
        id: 'source-project',
        label: 'project',
        root_path: '/example/project',
        access: 'read',
      }],
    })))

    const context = container.querySelector<HTMLElement>('.agent-composer-context')
    expect(context?.textContent).toContain('X launch.md')
    expect(context?.textContent).toContain('project')
    expect(container.querySelector('.agent-ai-footer')?.contains(context)).toBe(false)
    expect(context?.nextElementSibling?.tagName).toBe('TEXTAREA')
    expect(container.querySelector('.agent-turn-context-summary')).toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Remove X launch.md"]',
      )?.click()
    })
    expect(onRemoveDocumentContext).toHaveBeenCalledWith('Campaigns/X launch.md')
  })

  it('offers context actions from a plus button before the model picker', async () => {
    const onAddLocalSource = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      onAddLocalSource,
      onRemoveLocalSource: vi.fn(),
    })))

    const addButton = container.querySelector<HTMLButtonElement>('.agent-context-add__trigger')
    const footer = container.querySelector('.agent-ai-footer')
    const modelPicker = container.querySelector('.agent-ai-model-picker')
    expect(addButton?.getAttribute('aria-label')).toBe('Add context')
    expect(container.querySelector('.agent-composer-context')).toBeNull()
    expect(footer?.firstElementChild).toBe(addButton?.parentElement)
    // The kit edit mode toggle (live or draft) sits with the left-hand composer controls, between
    // the plus button and the model picker.
    const kitEditMode = container.querySelector('[data-testid="agent-kit-edit-mode"]')
    expect(kitEditMode).not.toBeNull()
    expect(addButton?.parentElement?.nextElementSibling).toBe(kitEditMode)
    expect(kitEditMode?.nextElementSibling).toBe(modelPicker)
    await act(async () => addButton?.click())
    const localFolder = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Local folder'))
    await act(async () => localFolder?.click())
    expect(onAddLocalSource).toHaveBeenCalledOnce()
  })

  it('keeps attached documents outside the visible draft', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      documentContextPaths: ['Docs/Current.md'],
      draft: 'Improve this',
      mentionableDocuments: [{
        kind: 'file',
        path: 'Docs/Current.md',
        name: 'Current.md',
        title: 'Current',
        format: 'markdown',
      }],
    })))

    expect(container.querySelectorAll('.agent-composer-context')).toHaveLength(1)
    expect(container.querySelector('.agent-composer-context')?.textContent).toContain('Current.md')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Improve this')
  })
})

describe('AgentChatPanel shell approval', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('lets the user approve once, remember a prefix, or deny', async () => {
    const onShellApprovalDecision = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Push the changes', [
        { type: 'tool/call', callId: 'call_21', name: 'exec_command', arguments: { cmd: ['git', 'push'] } },
        {
          type: 'tool/result', callId: 'call_21', name: 'exec_command', isError: false, content: [],
          value: { name: 'exec_command', summary: 'Waiting', output: { requires: 'approval', command: 'git push' } },
          meta: {
            kind: 'shell.approval', command: 'git push', requires: 'approval', decision: 'prompt',
            reason: 'Command not covered by any rule; user approval required.',
            suggested: { prefix: ['git'], decision: 'allow' },
          },
        },
        { type: 'approval/asked', id: 'approval:call_21', toolName: 'exec_command', callId: 'call_21' },
        { type: 'turn/end', turn: 1, reason: 'awaiting-approval' },
      ]),
      onShellApprovalDecision,
    })))

    const card = container.querySelector('[data-testid="agent-shell-approval"]')
    expect(card?.textContent).toContain('git push')
    const buttons = Array.from(card?.querySelectorAll('button') || [])
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Allow once',
      'Always allow "git"',
      'Deny',
    ])

    await act(async () => buttons[0]?.click())
    await act(async () => buttons[1]?.click())
    await act(async () => buttons[2]?.click())

    expect(onShellApprovalDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ call_id: 'call_21', command: 'git push' }),
      'allow_once',
    )
    expect(onShellApprovalDecision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ call_id: 'call_21' }),
      'allow_always',
    )
    expect(onShellApprovalDecision).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ call_id: 'call_21' }),
      'deny',
    )
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
      view: viewOf('Edit the article', ran('p1', 'apply_patch', {}, { file_ops: [{ path: 'Docs/Article.md' }] })),
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

  it('lists every changed document in the same bottom changed-files card', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Write the guide and a checklist', [
        ...ran('p1', 'apply_patch', {}, { file_ops: [{ path: 'Docs/Admissions guide.md' }] }),
        ...ran('w1', 'document_write', { path: 'Admissions/Checklist.md' }, { path: 'Admissions/Checklist.md' }),
      ]),
    })))

    const changedFiles = Array.from(container.querySelectorAll('.agent-changed-file-name'))
      .map((node) => node.textContent)
    const disclosure = container.querySelector<HTMLDetailsElement>('.agent-changed-files')

    expect(container.querySelector('.agent-changed-files-head')?.textContent).toContain('Files modified: 2')
    expect(disclosure?.open).toBe(false)
    expect(changedFiles).toEqual([
      'Admissions guide.md',
      'Checklist.md',
    ])
  })
})

describe('AgentChatPanel activity updates', () => {
  beforeEach(async () => {
    await unmount()
  })

  it('keeps running tool details collapsed until the user opens them', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Read the document', [
        { type: 'tool/call', callId: 'r1', name: 'document_read', arguments: { path: 'Docs/Plan.md' } },
      ]),
      busy: true,
    })))

    const row = container.querySelector<HTMLButtonElement>('.agent-run-log-row')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.agent-run-log-detail')).toBeNull()

    await act(async () => {
      row?.click()
    })

    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.agent-run-log-detail')).not.toBeNull()
  })

  it('follows new execution updates while the conversation remains at the bottom', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Read the document'),
    })))

    const messagesContainer = container.querySelector<HTMLElement>('[data-testid="agent-chat-messages"]')
    expect(messagesContainer).not.toBeNull()
    Object.defineProperty(messagesContainer, 'scrollHeight', { configurable: true, value: 640 })
    Object.defineProperty(messagesContainer, 'clientHeight', { configurable: true, value: 320 })
    messagesContainer!.scrollTop = 320

    await render(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Read the document', ran('r1', 'document_read', { path: 'Docs/Plan.md' }, { path: 'Docs/Plan.md', chars: 120 })),
      busy: true,
    })))

    expect(messagesContainer!.scrollTop).toBe(640)
  })

  it('does not pull the conversation down after the user scrolls up', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Read the document'),
    })))

    const messagesContainer = container.querySelector<HTMLElement>('[data-testid="agent-chat-messages"]')
    Object.defineProperty(messagesContainer, 'scrollHeight', { configurable: true, value: 640 })
    Object.defineProperty(messagesContainer, 'clientHeight', { configurable: true, value: 320 })
    messagesContainer!.scrollTop = 80
    await act(async () => {
      messagesContainer!.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const working = viewOf('Read the document')
    await render(createElement(AgentChatPanel, makeMinimalProps({
      view: { ...working, live: { attemptId: 'a', turn: 1, step: 1, text: 'Working on the next step', toolArgs: {} } },
      busy: true,
    })))

    expect(messagesContainer!.scrollTop).toBe(80)
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
  // pane-specific suggestions back through. Cover the panes
  // explicitly so one accidentally re-enabled pane fails its own
  // assertion.
  describe.each([
    { pane: 'document', leakedStarter: 'Summarize this document' },
    { pane: 'workflow', leakedStarter: 'Email me on every new record' },
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

    expect(container.querySelectorAll('.agent-chat-suggestion-card')).toHaveLength(0)
    expect(container.querySelectorAll('.agent-chat-empty-cta button')).toHaveLength(1)
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

  const longPath = 'Getting Started/Guides/Product Content/Product Content Studio.ktable'

  it('shows an attached document as a removable inline reference', async () => {
    const onRemoveDocumentContext = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'Analyze this document',
      documentContextPaths: [longPath],
      mentionableDocuments: [{
        kind: 'file',
        path: longPath,
        name: 'Product Content Studio.ktable',
        title: 'Product Content Studio',
        format: 'table',
      }],
      onRemoveDocumentContext,
    })))

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Analyze this document')
    expect(container.textContent).toContain('Product Content Studio.ktable')
    expect(container.textContent).not.toContain('@{')
    expect(container.textContent).not.toContain('Getting Started/Guides')

    const remove = document.querySelector(
      '[aria-label="Remove Product Content Studio.ktable"]',
    ) as HTMLButtonElement
    await act(async () => {
      remove.click()
    })
    expect(onRemoveDocumentContext).toHaveBeenCalledWith(longPath)
  })

  it('shows every attached filename without opening another panel', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'Compare these',
      documentContextPaths: ['Docs/Plan.md', 'Notes/Todo.md'],
      mentionableDocuments: [
        { kind: 'file', path: 'Docs/Plan.md', name: 'Plan.md', title: 'Plan', format: 'markdown' },
        { kind: 'file', path: 'Notes/Todo.md', name: 'Todo.md', title: 'Todo', format: 'markdown' },
      ],
    })))

    const context = container.querySelector<HTMLElement>('.agent-composer-context')!
    expect(context.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(context.textContent).toContain('Plan.md')
    expect(context.textContent).toContain('Todo.md')
    expect(container.querySelector('.agent-ai-footer')?.contains(context)).toBe(false)
  })

  it('moves a selected mention into persistent document context', async () => {
    const onDraftChange = vi.fn()
    const onAddDocumentContext = vi.fn()
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      draft: 'Compare @pla',
      documentContextPaths: ['Docs/Current.md'],
      mentionableDocuments: [
        { kind: 'file', path: 'Docs/Current.md', name: 'Current.md', title: 'Current', format: 'markdown' },
        { kind: 'file', path: 'Docs/Plan.md', name: 'Plan.md', title: 'Plan', format: 'markdown' },
      ],
      onDraftChange,
      onAddDocumentContext,
    })))

    const planMention = container.querySelector<HTMLButtonElement>('.agent-mention-menu__item')
    expect(planMention?.textContent).toContain('Plan')
    await act(async () => {
      planMention?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onDraftChange).toHaveBeenCalledWith('Compare ')
    expect(onAddDocumentContext).toHaveBeenCalledWith('Docs/Plan.md')
  })

  it('renders sent messages without repeating document attachment chips', async () => {
    await mount(createElement(AgentChatPanel, makeMinimalProps({
      view: viewOf('Summarize it'),
    })))

    const userMessage = container.querySelector('[data-role="user"]') as HTMLElement
    expect(userMessage.textContent).toContain('Summarize it')
    expect(userMessage.textContent).not.toContain('Product Content Studio.ktable')
    expect(userMessage.textContent).not.toContain('@{')
    expect(userMessage.textContent).not.toContain('Getting Started/Guides')
    expect(userMessage.querySelector('.agent-document-reference')).toBeNull()
  })
})
