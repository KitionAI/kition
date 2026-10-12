import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionEventsSessionEvent } from '@/api/generated/agent-session-events'
import approvalTurns from '../lib/__fixtures__/approvalTurns.json'
import { applySessionEvent, emptyAgentSessionView } from '../lib/agentSessionView'
import { AgentConversation } from './AgentConversation'

vi.mock('@/features/settings/hooks/useDesktopSettings', () => ({
  useDesktopSettings: () => ({ settings: { general: { language: 'en', debug: false } } }),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Props = ComponentProps<typeof AgentConversation>
type Body = { type: string } & Record<string, unknown>
const imagePath = 'Agent/images/46/Edited poster.png'

/** A one-turn log: the user's message, then `bodies`, then the end. */
function viewOf(bodies: Body[], ended = true) {
  const list = [
    { type: 'turn/start', turn: 1 },
    { type: 'step/start', turn: 1, step: 1 },
    { type: 'user/message', content: [{ type: 'text', text: 'Edit the poster' }], source: { kind: 'user' } },
    ...bodies,
    ...(ended ? [{ type: 'turn/end', turn: 1, reason: 'completed' }] : []),
  ].map((body, index) => ({ seq: index + 1, at: index + 1, ...body }) as AgentSessionEventsSessionEvent)
  return list.reduce(applySessionEvent, emptyAgentSessionView())
}

const toolRun = (name: string, output: unknown): Body[] => [
  { type: 'tool/call', callId: 'c1', name, arguments: {} },
  { type: 'tool/result', callId: 'c1', name, isError: false, content: [], value: { name, summary: 'Done', output } },
]

describe('Agent conversation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.kitionDesktop = { shell: 'tauri', backendOrigin: 'http://127.0.0.1:18102' }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete window.kitionDesktop
  })

  async function mount(extra: Partial<Props>) {
    const onOpenArtifact = vi.fn()
    await act(async () => root.render(createElement(AgentConversation, {
      view: viewOf([]), busy: false, onOpenPath: vi.fn(), onOpenArtifact, ...extra,
    })))
    return onOpenArtifact
  }

  it('opens completed tool output in the workspace', async () => {
    const onOpenArtifact = await mount({ view: viewOf(toolRun('image_generation', { path: imagePath })) })
    const thumbnail = container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!
    expect(thumbnail).not.toBeNull()
    expect(thumbnail.getAttribute('type')).toBe('button')
    expect(thumbnail.querySelector('img')?.src).toBe('http://127.0.0.1:18102/workspace-files/Agent/images/46/Edited%20poster.png')
    await act(async () => thumbnail.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
    expect(container.querySelector('a.agent-tool-image-thumb')).toBeNull()
  })

  it('opens a runtime image URL using its decoded workspace path', async () => {
    const onOpenArtifact = await mount({ view: viewOf(toolRun('image_generation', { images: [{
      url: 'http://127.0.0.1:18102/workspace-files/Agent/images/46/Edited%20poster.png',
    }] })) })
    await act(async () => container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
  })

  it('opens delivered images through the same workspace preview callback', async () => {
    const onOpenArtifact = await mount({ view: viewOf([
      ...toolRun('view_image', { path: 'elsewhere' }),
      { type: 'deliverables/presented', turn: 1, callId: 'c1', files: [{ path: imagePath, description: 'Edited poster' }] },
    ]) })
    await act(async () => container.querySelector<HTMLButtonElement>('button.agent-tool-image-thumb')!.click())
    expect(onOpenArtifact).toHaveBeenCalledExactlyOnceWith(imagePath)
  })

  it('preserves the source-page link for web image search results', async () => {
    const onOpenArtifact = await mount({ view: viewOf(toolRun('image_search', { images: [{
      url: 'https://example.com/image.png', preview_url: 'https://example.com/preview.png',
      page_url: 'https://example.com/source', title: 'Source image',
    }] })) })
    const thumbnail = container.querySelector<HTMLAnchorElement>('a.agent-tool-image-thumb')!
    expect(thumbnail.href).toBe('https://example.com/source')
    expect(thumbnail.target).toBe('_blank')
    expect(thumbnail.querySelector('img')?.src).toBe('https://example.com/preview.png')
    expect(container.querySelector('button.agent-tool-image-thumb')).toBeNull()
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })

  it('shows the user message, the reply, and hides hidden resume messages', async () => {
    const view = (approvalTurns as AgentSessionEventsSessionEvent[]).reduce(applySessionEvent, emptyAgentSessionView())
    await mount({ view })
    const users = [...container.querySelectorAll('[data-role="user"]')].map((node) => node.textContent)
    expect(users).toEqual(['Write a short plan'])
    const replies = [...container.querySelectorAll('[data-role="assistant"]')].map((node) => node.textContent?.trim())
    expect(replies).toEqual(['Done.'])
    expect(container.querySelector('[data-testid="agent-shell-approval"]')).toBeNull()
  })

  it('shows the approval card while the turn waits and resumes with the call id', async () => {
    const view = (approvalTurns as AgentSessionEventsSessionEvent[]).slice(0, 11).reduce(applySessionEvent, emptyAgentSessionView())
    const onShellApprovalDecision = vi.fn()
    await mount({ view, onShellApprovalDecision })
    const card = container.querySelector('[data-testid="agent-shell-approval"]')!
    expect(card.textContent).toContain('ls && touch approved.txt')
    await act(async () => card.querySelector<HTMLButtonElement>('.agent-shell-approval__allow')!.click())
    expect(onShellApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ call_id: 'call_1', command: 'ls && touch approved.txt' }),
      'allow_once',
    )
  })

  it('streams live text and shows a pending message until its turn is logged', async () => {
    const view = { ...viewOf([], false), running: true, live: { attemptId: 'a', turn: 1, step: 1, text: 'Drafting', toolArgs: {} } }
    await mount({ view, busy: true })
    expect(container.querySelector('.agent-message.is-streaming')?.textContent?.trim()).toBe('Drafting')
    await mount({ view: viewOf([]), busy: true, pendingUserText: 'Next question' })
    const users = [...container.querySelectorAll('[data-role="user"]')].map((node) => node.textContent)
    expect(users).toEqual(['Edit the poster', 'Next question'])
    expect(container.querySelector('.agent-exec-thinking')).not.toBeNull()
  })

  it('keeps the partial text of an interrupted turn and says the outcome is unknown', async () => {
    const view = { ...viewOf([], false) }
    view.turns = [{ ...view.turns[0], interrupted: true, partialReply: 'Half an answer' }]
    await mount({ view })
    expect(container.querySelector('[data-role="assistant"]')?.textContent?.trim()).toBe('Half an answer')
    expect(container.textContent).toContain('Completion not confirmed')
  })
})
