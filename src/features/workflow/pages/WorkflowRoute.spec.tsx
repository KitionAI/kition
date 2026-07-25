import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { WorkflowRoute } from './WorkflowRoute'
import { loadDesktopSettings } from '@/services/desktopSettings'

vi.mock('@/services/desktop', () => ({
  getApiBaseURL: () => 'http://test',
  normalizeApiPath: (p: string) => p,
  resolveApiURL: (p: string) => `http://test${p}`,
  waitForDesktopBackendReady: () => Promise.resolve(true),
}))
vi.mock('@/services/desktopSettings', () => ({ loadDesktopSettings: vi.fn() }))
vi.mock('./WorkflowHomePage', () => ({
  WorkflowHomePage: ({ streamingPreview, scopedKitablePath }: { streamingPreview?: { workflow?: { id?: string; name?: string } | null; status?: string; createdId?: string | null } | null; scopedKitablePath?: string }) => (
    <div
      data-testid="workflow-home-page"
      data-scoped-kitable-path={scopedKitablePath ?? ''}
      data-streaming-status={streamingPreview?.status ?? ''}
      data-streaming-workflow-id={streamingPreview?.workflow?.id ?? ''}
      data-streaming-created-id={streamingPreview?.createdId ?? ''}
    />
  ),
}))
// /workflow and /workflow/new (no context) both render WorkflowIndexPage now
// (the route-split landed in kition-workflow-design 2026-06-21). Stub it out
// so the route tests can assert on data-testid="workflow-index-page" without
// dragging the real index page's API + data-doc fetches into this spec.
vi.mock('./WorkflowIndexPage', () => ({
  WorkflowIndexPage: ({ initialModeDialogOpen, scopedKitablePath }: { initialModeDialogOpen?: boolean; scopedKitablePath?: string }) => (
    <div
      data-testid="workflow-index-page"
      data-initial-mode-dialog-open={initialModeDialogOpen ? 'true' : 'false'}
      data-scoped-kitable-path={scopedKitablePath ?? ''}
    />
  ),
}))

const CONFIGURED_SETTINGS = {
  models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-4o' }, preferredChatModel: '', preferredWritingModel: '' },
  providers: {
    openai: { enabled: true, apiKey: 'sk-test', label: 'OpenAI', baseUrl: '', discoveredModels: ['gpt-4o'] },
  },
}

let container: HTMLDivElement; let root: Root | null = null
async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => { root = createRoot(container); root.render(node); await Promise.resolve() })
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ;(loadDesktopSettings as Mock).mockResolvedValue(CONFIGURED_SETTINGS)
})
afterEach(() => { root?.unmount(); container.remove(); vi.restoreAllMocks() })

describe('WorkflowRoute', () => {
  it('mounts WorkflowIndexPage at /workflow without context', async () => {
    window.history.replaceState({}, '', '/workflow')
    await mount(createElement(WorkflowRoute, {
      workflowContext: null,
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="workflow-index-page"]')).not.toBeNull()
  })

  it('forwards the active kitable scope to the workflow index route', async () => {
    window.history.replaceState({}, '', '/workflow')
    await mount(createElement(WorkflowRoute, {
      workflowContext: null,
      scopedKitablePath: 'Getting Started/Tasks.kitable',
      rootPath: '/tmp/workspace',
      schemaLookup: async () => ({ id: 'tbl', name: 'Tasks', fields: [] }),
    }))
    expect(
      container.querySelector('[data-testid="workflow-index-page"]')
        ?.getAttribute('data-scoped-kitable-path'),
    ).toBe('Getting Started/Tasks.kitable')
  })

  it('opens WorkflowIndexPage with the create-mode dialog pre-open when /workflow/new has no context', async () => {
    window.history.replaceState({}, '', '/workflow/new')
    await mount(createElement(WorkflowRoute, {
      workflowContext: null,
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    expect(container.querySelector('[data-testid="workflow-index-page"]')?.getAttribute('data-initial-mode-dialog-open')).toBe('true')
  })

  it('mounts WorkflowNewPage at /workflow/new', async () => {
    window.history.replaceState({}, '', '/workflow/new')
    await mount(createElement(WorkflowRoute, {
      workflowContext: { documentId: 'doc_1', tableId: 'tbl', tableName: 'Leads' },
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    expect(container.querySelector('[data-testid="workflow-new-page"]')).not.toBeNull()
  })

  // Without `?mode=ai` the user lands on the gallery hero — they have to
  // click "Generate With AI" to reach the prompt. This is the default
  // /workflow/new entry (e.g. via the homepage Create button).
  it('without ?mode=ai, launches the gallery hero (default editor mode)', async () => {
    window.history.replaceState({}, '', '/workflow/new')
    await mount(createElement(WorkflowRoute, {
      workflowContext: { documentId: 'doc_1', tableId: 'tbl', tableName: 'Leads' },
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    expect(container.querySelector('[data-testid="workflow-prompt"]')).toBeNull()
    expect(container.textContent).toMatch(/Automate any task with workflows/)
  })

  // With `?mode=ai`, the WorkflowLauncher is mounted with
  // initialView='ai-prompt' so the user lands directly on the prompt
  // textarea — no extra "Generate With AI" click needed. This is the
  // "Created by chat (AI)" path coming from the workspace mode dialog.
  it('with ?mode=ai, mounts the AI prompt hero directly', async () => {
    window.history.replaceState({}, '', '/workflow/new?mode=ai')
    await mount(createElement(WorkflowRoute, {
      workflowContext: { documentId: 'doc_1', tableId: 'tbl', tableName: 'Leads' },
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    expect(container.querySelector('[data-testid="workflow-prompt"]')).not.toBeNull()
  })

  // history.state.workflowMode also drives the mode, so callers that push
  // state without serialising the URL search string still reach the AI hero.
  it('with history.state.workflowMode="ai" (no URL query), mounts the AI prompt', async () => {
    window.history.replaceState({ workflowMode: 'ai' }, '', '/workflow/new')
    await mount(createElement(WorkflowRoute, {
      workflowContext: { documentId: 'doc_1', tableId: 'tbl', tableName: 'Leads' },
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [] }),
    }))
    expect(container.querySelector('[data-testid="workflow-prompt"]')).not.toBeNull()
  })

  it('hands the streaming preview to WorkflowHomePage once the user submits an AI prompt', async () => {
    const events = [
      JSON.stringify({ kind: 'workflow.generated', workflowId: 'auto_1', name: 'N', description: 'D' }),
      JSON.stringify({ kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl', config: {} }),
      JSON.stringify({ kind: 'action.generated', nodeId: 'n2', actionType: 'send_email', config: { to: 'a@b', subject: 's', body: { parts: [] } } }),
      JSON.stringify({ kind: 'workflow.created', workflowId: 'real_1' }),
      JSON.stringify({ kind: 'done' }),
    ]
    const encoder = new TextEncoder()
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(events.map((f) => `data: ${f}\n\n`).join(''))); c.close() },
      }), { headers: { 'content-type': 'text/event-stream' } })),
    ) as unknown as typeof fetch

    window.history.replaceState({}, '', '/workflow/new')
    await mount(createElement(WorkflowRoute, {
      workflowContext: { documentId: 'doc_1', tableId: 'tbl', tableName: 'Leads' },
      schemaLookup: async () => ({ id: 'tbl', name: 'Leads', fields: [{ id: 'fld_a', name: 'A', type: 'text' }] }),
    }))
    await act(async () => {
      container.querySelector('[data-testid="workflow-launcher-cta-ai"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('[data-testid="workflow-prompt"]') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'p')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('[data-testid="workflow-launcher-ai-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    // No standalone surface anymore — the home page renders and receives the
    // synthesized streaming preview (id rewritten to the sentinel).
    const homePage = container.querySelector('[data-testid="workflow-home-page"]')
    expect(homePage).not.toBeNull()
    expect(homePage?.getAttribute('data-streaming-workflow-id')).toBe('__streaming__')
    // workflow.created arrived in the same batch → URL gets replaceState'd to
    // /workflow with selectedWorkflowId pointing at the real persisted id.
    expect(window.location.pathname).toBe('/workflow')
    expect((window.history.state as { selectedWorkflowId?: string } | null)?.selectedWorkflowId).toBe('real_1')
    expect(homePage?.getAttribute('data-streaming-created-id')).toBe('real_1')
  })
})
