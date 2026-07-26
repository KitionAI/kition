import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/workflow/api', () => ({
  createWorkflow: vi.fn(),
}))
vi.mock('@/features/workflow/lib/openWorkflowRoute', async (importOriginal) => {
  const actual: any = await importOriginal()
  return { ...actual, openWorkflowHome: vi.fn() }
})

import * as api from '@/features/workflow/api'
import * as router from '@/features/workflow/lib/openWorkflowRoute'
import { WorkflowLauncher } from './WorkflowLauncher'
import type { WorkflowLauncherProps } from './WorkflowLauncher'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tableContext = {
  documentId: 'doc1',
  tableId: 't1',
  tableName: 'Leads',
}

const baseProps: WorkflowLauncherProps = {
  tableContext,
  onAiSubmit: vi.fn(),
}

let container: HTMLDivElement
let root: Root | null = null

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function queryByTestId(id: string) {
  return container.querySelector(`[data-testid="${id}"]`)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(api.createWorkflow).mockReset()
  vi.mocked(router.openWorkflowHome).mockReset()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
})

describe('WorkflowLauncher', () => {
  // Test 1: Renders gallery hero by default
  it('renders gallery hero by default', async () => {
    await mount(createElement(WorkflowLauncher, baseProps))
    expect(container.textContent).toContain('Automate any task with workflows')
  })

  // Test 2: Generate With AI swaps to ai-prompt view; Escape returns to gallery
  it('Generate With AI swaps to ai-prompt view; window Escape returns to gallery', async () => {
    await mount(createElement(WorkflowLauncher, baseProps))
    // Click the AI CTA button
    const aiCta = queryByTestId('workflow-launcher-cta-ai')
    expect(aiCta).not.toBeNull()
    await act(async () => {
      aiCta!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // Should now show AI prompt textarea
    expect(queryByTestId('workflow-prompt')).not.toBeNull()
    // Press Escape to return to gallery
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    // Should be back to gallery view (textarea gone)
    expect(queryByTestId('workflow-prompt')).toBeNull()
    expect(container.textContent).toContain('Automate any task with workflows')
  })

  // Test 3: Submitting AI prompt calls onAiSubmit with the trimmed prompt
  it('submitting AI prompt calls onAiSubmit with the trimmed prompt', async () => {
    const onAiSubmit = vi.fn()
    await mount(createElement(WorkflowLauncher, { ...baseProps, onAiSubmit }))
    // Switch to ai-prompt view
    const aiCta = queryByTestId('workflow-launcher-cta-ai')
    await act(async () => {
      aiCta!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // Type a prompt in the textarea
    const textarea = queryByTestId('workflow-prompt') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '  send email  ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    // Click AI submit
    const submitBtn = queryByTestId('workflow-launcher-ai-submit')
    await act(async () => {
      submitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onAiSubmit).toHaveBeenCalledWith('send email', tableContext)
  })

  // Test 4: Start From Scratch calls createWorkflow with placeholder defaults and navigates
  it('Start From Scratch calls createWorkflow with placeholder defaults and navigates', async () => {
    vi.mocked(api.createWorkflow).mockResolvedValueOnce({ id: 'auto_new' } as never)
    await mount(createElement(WorkflowLauncher, baseProps))
    const scratchBtn = queryByTestId('workflow-launcher-cta-scratch')
    expect(scratchBtn).not.toBeNull()
    await act(async () => {
      scratchBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    const callArg = vi.mocked(api.createWorkflow).mock.calls[0][0]
    expect(callArg.enabled).toBe(false)
    expect(callArg.name).toBe('Untitled workflow')
    expect(callArg.trigger.tableId).toBe('t1')
    expect(callArg.action.to).toBe('you@example.com')
    expect(vi.mocked(router.openWorkflowHome)).toHaveBeenCalledWith({ workflowId: 'auto_new' })
  })

  // Test 5: Clicking a template calls createWorkflow and navigates to home with the new id
  it('clicking a template calls createWorkflow and navigates to home with new id', async () => {
    vi.mocked(api.createWorkflow).mockResolvedValueOnce({ id: 'auto_new' } as never)
    await mount(createElement(WorkflowLauncher, baseProps))
    // Click the first template card
    const templateCard = container.querySelector('[data-testid="workflow-launcher-template-card"]')
    expect(templateCard).not.toBeNull()
    await act(async () => {
      templateCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(vi.mocked(api.createWorkflow)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(router.openWorkflowHome)).toHaveBeenCalledWith({ workflowId: 'auto_new' })
  })

  // Test 6: Explore more opens the template sheet
  it('Explore more opens the template sheet', async () => {
    await mount(createElement(WorkflowLauncher, baseProps))
    // Sheet should be closed initially
    expect(queryByTestId('workflow-launcher-template-sheet')).toBeNull()
    const exploreMore = queryByTestId('workflow-launcher-explore-more')
    expect(exploreMore).not.toBeNull()
    await act(async () => {
      exploreMore!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // Sheet should be open now
    expect(queryByTestId('workflow-launcher-template-sheet')).not.toBeNull()
  })

  // Test 7: AI Agent card dispatches kition:assistant:open CustomEvent
  it('AI Agent card dispatches kition:assistant:open CustomEvent with correct detail', async () => {
    await mount(createElement(WorkflowLauncher, baseProps))
    const received: CustomEvent[] = []
    function listener(e: Event) {
      received.push(e as CustomEvent)
    }
    window.addEventListener('kition:assistant:open', listener)
    try {
      const agentCard = container.querySelector('[data-testid="workflow-launcher-agent-card"]')
      expect(agentCard).not.toBeNull()
      await act(async () => {
        agentCard!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(received).toHaveLength(1)
      expect(received[0].detail.tableContext.tableId).toBe('t1')
      expect(received[0].detail.source).toBe('workflow-launcher')
    } finally {
      window.removeEventListener('kition:assistant:open', listener)
    }
  })

  // Test 8: createWorkflow rejection surfaces inline error
  it('createWorkflow rejection surfaces inline error', async () => {
    vi.mocked(api.createWorkflow).mockRejectedValueOnce(new Error('boom'))
    await mount(createElement(WorkflowLauncher, baseProps))
    const scratchBtn = queryByTestId('workflow-launcher-cta-scratch')
    await act(async () => {
      scratchBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    const errEl = queryByTestId('workflow-model-error')
    expect(errEl).not.toBeNull()
    expect(errEl?.textContent).toContain('boom')
  })

  // Test 9: initialView='ai-prompt' renders the AI prompt textarea immediately
  //
  // Wired so the workspace "Created by chat (AI)" path (which sets
  // `?mode=ai` + history.state.workflowMode='ai') can drop the user
  // straight into the prompt. Without this the gallery hero shows first
  // and the user has to click a second "Generate With AI" CTA — which
  // reads as "nothing happened" since the dialog navigation just lands on
  // the same launcher they would see otherwise.
  it('initialView="ai-prompt" mounts directly on the AI prompt textarea', async () => {
    await mount(createElement(WorkflowLauncher, { ...baseProps, initialView: 'ai-prompt' }))
    // The AI prompt textarea must be visible without any user interaction.
    expect(queryByTestId('workflow-prompt')).not.toBeNull()
    // The gallery hero copy must NOT be visible — the back button is the
    // only way back to it.
    expect(container.textContent).not.toContain('Automate any task with workflows')
  })

  // Test 10: initialView defaults to 'gallery' (regression guard for existing callers)
  it('without initialView prop, falls back to gallery hero (legacy behavior)', async () => {
    await mount(createElement(WorkflowLauncher, baseProps))
    expect(queryByTestId('workflow-prompt')).toBeNull()
    expect(container.textContent).toContain('Automate any task with workflows')
  })
})
