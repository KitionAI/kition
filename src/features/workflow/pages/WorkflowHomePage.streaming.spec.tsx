import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listDataDocuments } from '@/api/dataDocuments'
import {
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  patchWorkflow,
  type WorkflowDefinition,
} from '@/features/workflow/api'
import { listChannels, listConnections } from '@/features/connections/api'
import { STREAMING_WORKFLOW_ID, withStreamingId } from '@/features/workflow/lib/aiBuildPreview'
import type { StreamingPreview } from './WorkflowHomePage'
import { WorkflowHomePage } from './WorkflowHomePage'

vi.mock('@/features/workflow/api', () => ({
  listWorkflows: vi.fn(),
  patchWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  listWorkflowRuns: vi.fn(),
  createWorkflow: vi.fn(),
  validateWorkflow: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/features/connections/api', () => ({
  listChannels: vi.fn(),
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
}))

vi.mock('@/features/connections/ConnectionsSettingsPanel', () => ({
  ConnectionModal: () => null,
}))

vi.mock('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog', () => ({
  WorkspaceWorkflowCreateModeDialog: () => null,
}))

vi.mock('@/api/dataDocuments', () => ({
  listDataDocuments: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('@/features/workflow/lib/aiChatBridge', () => ({
  publishWorkflowAiBuildOpen: vi.fn(),
}))

let container: HTMLDivElement
let root: Root | null = null

const realWorkflow: WorkflowDefinition = {
  id: 'real_1',
  name: 'Existing workflow',
  description: '',
  enabled: false,
  trigger: { nodeId: 'trigger_1', type: 'record_created', documentId: 'doc_1', tableId: 'tbl_1' },
  action: {
    nodeId: 'action_1',
    type: 'send_email',
    to: 'sales@example.com',
    subject: { parts: [{ kind: 'text' as const, text: 'New lead' }] },
    body: { parts: [{ kind: 'text', text: 'Hello' }] },
  },
}

function buildStreamingPreview(overrides: Partial<StreamingPreview> = {}): StreamingPreview {
  const synth: WorkflowDefinition = withStreamingId({
    id: 'future_id',
    name: 'Streaming workflow',
    description: '',
    enabled: false,
    trigger: { nodeId: 'trigger_pre', type: 'record_created', tableId: 'tbl_1', documentId: 'doc_1' },
    action: {
      nodeId: 'action_pre',
      type: 'send_email',
      to: 'someone@example.com',
      subject: { parts: [{ kind: 'text', text: 'Streaming subject' }] },
      body: { parts: [] },
    },
    nodes: [
      { nodeId: 'trigger_pre', kind: 'trigger', config: {} },
      { nodeId: 'action_pre', kind: 'action', config: {} },
    ],
    edges: [{ from: 'trigger_pre', to: 'action_pre' }],
  })
  return {
    workflow: synth,
    status: 'streaming',
    phase: 'generating-action',
    prompt: 'create me a workflow',
    error: null,
    schema: { id: 'tbl_1', name: 'Leads', fields: [{ id: 'fld_name', name: 'name', type: 'text' }] },
    createdId: null,
    ...overrides,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { items: [] } }),
  } as Response)
  vi.mocked(listDataDocuments).mockResolvedValue({
    items: [{ title: 'Leads doc', tables: [{ id: 'tbl_1', title: 'Leads' }] }],
  } as any)
  vi.mocked(listWorkflows).mockResolvedValue([realWorkflow])
  vi.mocked(listWorkflowRuns).mockResolvedValue([])
  vi.mocked(listChannels).mockResolvedValue([])
  vi.mocked(listConnections).mockResolvedValue([])
  vi.mocked(patchWorkflow).mockResolvedValue(realWorkflow)
  vi.mocked(deleteWorkflow).mockResolvedValue({ ok: true })
  // history is shared across tests — wipe selectedWorkflowId so prior tests
  // don't pre-select something the next test isn't expecting.
  window.history.replaceState({}, '', '/workflow')
})

afterEach(() => {
  root?.unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('WorkflowHomePage streamingPreview', () => {
  it('selects the synthetic streaming workflow and shows the streaming banner in the detail editor', async () => {
    const preview = buildStreamingPreview()
    await mount(createElement(WorkflowHomePage, { streamingPreview: preview }))
    await flush()
    expect(container.querySelector('[data-testid="workflow-home-name"]')).toBeNull()
    // The configuration tab's banner switches from the StatusBannerSlot to
    // the streaming progress banner.
    expect(container.querySelector('[data-testid="workflow-home-streaming-banner"]')).not.toBeNull()
  })

  it('disables OFF toggle, run-test, save, and menu delete while the preview is locked', async () => {
    const preview = buildStreamingPreview()
    await mount(createElement(WorkflowHomePage, { streamingPreview: preview }))
    await flush()
    expect(container.querySelector('[data-testid="status-toggle"]')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('[data-testid="workflow-home-run-test"]')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('[data-testid="workflow-home-save-topbar"]')?.hasAttribute('disabled')).toBe(true)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="workflow-home-more-actions"]')?.click()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="workflow-home-delete"]')?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('[data-testid="workflow-home-name"]')).toBeNull()
  })

  it('routes saveSelected / toggleSelected / requestDelete through a streaming-id guard (no API call)', async () => {
    const preview = buildStreamingPreview()
    await mount(createElement(WorkflowHomePage, { streamingPreview: preview }))
    await flush()
    // Even if a stray click slipped through (e.g. a programmatic submit),
    // none of the destructive APIs should ever see __streaming__ — the
    // disabled attribute alone wouldn't catch a synthesized click event
    // dispatched through the DOM directly.
    container.querySelector<HTMLButtonElement>('[data-testid="status-toggle"]')?.click()
    container.querySelector<HTMLButtonElement>('[data-testid="workflow-home-more-actions"]')?.click()
    await flush()
    document.querySelector<HTMLButtonElement>('[data-testid="workflow-home-delete"]')?.click()
    await flush()
    expect(vi.mocked(patchWorkflow)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteWorkflow)).not.toHaveBeenCalled()
  })

  it('once createdId arrives, refreshes the list, swaps selectedId to the real id, and signals onStreamingComplete', async () => {
    const preview = buildStreamingPreview()
    const onStreamingComplete = vi.fn()
    await mount(createElement(WorkflowHomePage, { streamingPreview: preview, onStreamingComplete }))
    await flush()
    expect(vi.mocked(listWorkflows).mock.calls.length).toBeGreaterThan(0)
    const callsBefore = vi.mocked(listWorkflows).mock.calls.length

    // The route would pass an updated preview with createdId once
    // workflow.created arrives.
    await act(async () => {
      root!.render(createElement(WorkflowHomePage, {
        streamingPreview: { ...preview, createdId: 'real_1', phase: 'persisting' },
        onStreamingComplete,
      }))
    })
    await flush()
    // refresh() runs again to pull the persisted row.
    expect(vi.mocked(listWorkflows).mock.calls.length).toBeGreaterThan(callsBefore)
    // onStreamingComplete fires with the real id so the route can release
    // its useWorkflowBuild state.
    expect(onStreamingComplete).toHaveBeenCalledWith('real_1')
  })
})
