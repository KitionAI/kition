import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listDataDocuments } from '@/api/dataDocuments'
import {
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  patchWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
} from '@/features/workflow/api'
import { listChannels, listConnections } from '@/features/connections/api'
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
  ConnectionModal: ({ onSaved }: { onSaved: (connection: any) => void }) => (
    <button type="button" data-testid="mock-connection-modal-save" onClick={() => onSaved({ id: 'conn_new' })}>
      Save connection
    </button>
  ),
}))

vi.mock('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog', () => ({
  WorkspaceWorkflowCreateModeDialog: ({ open, onSelect }: {
    open: boolean
    onSelect: (choice: { kind: 'chat' } | { kind: 'scratch' } | { kind: 'template'; template: { id: string } }) => void
  }) => open ? (
    <button
      type="button"
      data-testid="mock-create-mode-chat"
      onClick={() => onSelect({ kind: 'chat' })}
    >
      Pick chat
    </button>
  ) : null,
}))

vi.mock('@/features/workflow/lib/openWorkflowRoute', () => ({
  openWorkflowRoute: vi.fn(),
  openWorkflowHome: vi.fn(),
}))

vi.mock('@/api/dataDocuments', () => ({
  listDataDocuments: vi.fn().mockResolvedValue({
    items: [{
      title: 'Leads doc',
      tables: [{
        id: 'tbl_1',
        title: 'Leads',
      }],
    }],
  }),
}))

let container: HTMLDivElement
let root: Root | null = null

const workflow: WorkflowDefinition = {
  id: 'auto_1',
  name: 'Lead follow-up',
  description: 'Email sales',
  enabled: false,
  trigger: { nodeId: 'trigger_1', type: 'record_created', documentId: 'doc_1', tableId: 'tbl_1' },
  action: {
    nodeId: 'action_1',
    type: 'send_email',
    to: 'sales@example.com',
    subject: { parts: [{ kind: 'text' as const, text: 'New lead' }] },
    body: { parts: [{ kind: 'text', text: 'Hello ' }, { kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: 'fld_name' } }] },
  },
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
    json: async () => ({
      data: {
        items: [
          { id: 'fld_name', name: 'name', title: 'Name', type: 'text' },
          { id: 'fld_email', name: 'email', title: 'Email', type: 'text' },
        ],
      },
    }),
  } as Response)
  vi.mocked(listDataDocuments).mockResolvedValue({
    items: [{
      title: 'Leads doc',
      tables: [{
        id: 'tbl_1',
        title: 'Leads',
      }],
    }],
  } as any)
  vi.mocked(listWorkflows).mockResolvedValue([workflow])
  vi.mocked(listWorkflowRuns).mockResolvedValue([])
  vi.mocked(listChannels).mockResolvedValue([{ channel: 'email_smtp', label: 'Email SMTP', icon: 'mail', description: '', auth: 'form', fields: [] }])
  vi.mocked(listConnections).mockResolvedValue([{
    id: 'conn_1',
    channel: 'email_smtp',
    name: 'Sales SMTP',
    settings: { from: 'sales@example.com', host: 'smtp.example.com' },
    status: 'active',
    createdAt: '',
    updatedAt: '',
  }])
  vi.mocked(patchWorkflow).mockImplementation(async (_id, patch) => ({
    ...workflow,
    ...patch,
    trigger: {
      ...workflow.trigger,
      ...patch.trigger,
    },
    action: {
      ...workflow.action,
      ...patch.action,
    },
  }))
  vi.mocked(deleteWorkflow).mockResolvedValue({ ok: true })
  vi.mocked(validateWorkflow).mockResolvedValue([])
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container.remove()
  vi.restoreAllMocks()
})

describe('WorkflowHomePage', () => {
  it('renders detail from a selected workflow', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    expect(container.querySelector('[data-testid="workflow-home-page"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="workflow-home-to"]') as HTMLInputElement).value).toBe('sales@example.com')
    expect(container.querySelector('[data-testid="workflow-home-tabs"]')).toBeNull()
    expect(container.querySelector('[data-testid="workflow-home-configuration-tab"]')).not.toBeNull()
  })

  it('renders an empty state', async () => {
    vi.mocked(listWorkflows).mockResolvedValue([])

    await mount(createElement(WorkflowHomePage))

    // Post route-split: /workflow renders WorkflowIndexPage; this page's
    // own empty state is now the hero launcher (no kitable scope) rather
                                 
    expect(container.querySelector('[data-testid="workflow-home-launcher"]')).not.toBeNull()
  })

  it('saves basic workflow edits without rendering the workflow name in the topbar', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    expect(container.querySelector('[data-testid="workflow-home-name"]')).toBeNull()
    const recipient = container.querySelector('[data-testid="workflow-home-to"]') as HTMLInputElement
    await act(async () => {
      setInputValue(recipient, 'ops@example.com')
    })
    await act(async () => {
      container.querySelector('[data-testid="workflow-home-save-topbar"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(patchWorkflow).toHaveBeenCalledWith('auto_1', expect.objectContaining({
      name: 'Lead follow-up',
      action: expect.objectContaining({
        to: 'ops@example.com',
        body: expect.objectContaining({
          parts: expect.arrayContaining([expect.objectContaining({ kind: 'field_ref' })]),
        }),
      }),
    }))
  })

  it('saves selected connection id with workflow edits', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    await act(async () => {
      const select = container.querySelector('[data-testid="workflow-home-connection"]') as HTMLSelectElement
      select.value = 'conn_1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('[data-testid="workflow-home-save"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(patchWorkflow).toHaveBeenCalledWith('auto_1', expect.objectContaining({
      action: expect.objectContaining({ connectionId: 'conn_1' }),
    }))
  })

  it('opens the action drawer with existing connections when fixing a missing connection', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    const triggerNode = container.querySelector('[data-node-role="trigger"]') as HTMLElement
    await act(async () => {
      triggerNode.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(triggerNode.dataset.selected).toBe('true')

    await act(async () => {
      container.querySelector('[data-testid="workflow-node-fix"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-testid="mock-connection-modal-save"]')).toBeNull()
    const actionNode = container.querySelector('[data-node-role="action"]') as HTMLElement
    expect(actionNode.dataset.selected).toBe('true')

    const select = container.querySelector('[data-testid="workflow-home-connection"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.options[0]?.textContent).toBe('No connection selected')
    expect(Array.from(select.options).some((option) => option.value === 'conn_1' && option.textContent?.includes('Sales SMTP'))).toBe(true)
  })

  // The list search + filter chips moved to WorkflowIndexPage (kition-workflow-design
  // route split: /workflow renders the list, /workflow/{id} renders this detail page).
  // The corresponding coverage now lives in WorkflowIndexPage.spec.tsx.

  it('edits body tokens and shows dirty-only save bar', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    expect(container.querySelector('[data-testid="workflow-home-save-bar-hidden"]')).not.toBeNull()

    // The email body editor switched from the old <select>-based
    // BodyTemplateEditor to the inline contenteditable TemplateTokenInput.
    // Token insertion now goes: click the "+" trigger → click a field row
    // in the popover. The popover renders into a portal (document.body),
    // and TemplateTokenInput.insertNodeAtCaret needs a real Selection
    // range pointing into the editor — without one the inserted chip is
    // dropped on the floor. Seed the range at the end of the editor so
    // the chip appends after the existing "Hello " + fld_name content.
    const editor = container.querySelector('[data-testid="workflow-home-body-editor"]') as HTMLDivElement
    expect(editor).not.toBeNull()
    await act(async () => {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      container.querySelector('[data-testid="workflow-home-body-add"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    await act(async () => {
      const fieldOption = document.querySelector(
        '[data-testid="template-token-field-fld_email"]',
      ) as HTMLButtonElement | null
      expect(fieldOption).not.toBeNull()
      fieldOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="workflow-home-save-bar"]')?.textContent).toContain('Body')
    await act(async () => {
      container.querySelector('[data-testid="workflow-home-save"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const call = vi.mocked(patchWorkflow).mock.calls.at(-1)!
    expect(JSON.stringify(call[1].action?.body)).toContain('"field_ref"')
    expect(JSON.stringify(call[1].action?.body)).not.toContain('{{')
  })

  it('renders body tokens with fallback field labels when table schema cannot load', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to open data document' }),
    } as Response)

    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    // Body editor migrated from BodyTemplateEditor → TemplateTokenInput.
    // Wrapper testid is the same one the page passes in (workflow-home-body);
    // contenteditable host is "{testId}-editor". When the schema fetch
    // fails the chip falls back to rendering the raw fieldId as its label
    // (see createChipElement: `label = field?.name ?? fallbackId`) — that
    // way the user can still see what's bound and remove the dangling
    // reference without the editor crashing on a null schema.
    expect(container.querySelector('[data-testid="workflow-home-body-loading"]')).toBeNull()
    expect(container.querySelector('[data-testid="workflow-home-body"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="workflow-home-body-editor"]')?.textContent).toContain('fld_name')
  })

  it('sends a real test email from Run test and shows delivery details', async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/send-test')) {
        expect(init?.method).toBe('POST')
        return {
          ok: true,
          json: async () => ({
            ok: true,
            input: {
              to: 'sales@example.com',
              subject: 'New lead',
              body: 'Hello Bieber',
            },
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [
              { id: 'fld_name', name: 'name', title: 'Name', type: 'text' },
              { id: 'fld_email', name: 'email', title: 'Email', type: 'text' },
            ],
          },
        }),
      } as Response
    })

    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))
    await act(async () => {
      container.querySelector('[data-testid="workflow-home-run-test"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="workflow-home-run-test-status"]')?.textContent).toContain('Test email delivered')
    expect(container.querySelector('[data-testid="workflow-home-run-test-preview"]')?.textContent).toContain('sales@example.com')
    expect(container.querySelector('[data-testid="workflow-home-run-test-body"]')?.textContent).toContain('Hello Bieber')
  })

  it('deletes the selected workflow', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    await act(async () => {
      container.querySelector('[data-testid="workflow-home-more-actions"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      document.querySelector('[data-testid="workflow-home-delete"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    await act(async () => {
      document.querySelector('[data-testid="workflow-home-confirm-ok"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(deleteWorkflow).toHaveBeenCalledWith('auto_1')
  })

  it('opens configuration, run history, and logs from the More menu instead of tabs', async () => {
    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    expect(container.querySelector('[data-testid="workflow-home-tabs"]')).toBeNull()
    await act(async () => {
      container.querySelector('[data-testid="workflow-home-more-actions"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="workflow-home-view-configuration"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="workflow-home-history"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="workflow-home-logs"]')).not.toBeNull()

    await act(async () => {
      document.querySelector('[data-testid="workflow-home-history"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="run-history-panel"]')).not.toBeNull()

    await act(async () => {
      container.querySelector('[data-testid="workflow-home-more-actions"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      document.querySelector('[data-testid="workflow-home-logs"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="workflow-home-logs-tab"]')).not.toBeNull()
  })

  it('PATCHes the workflow trigger when the user picks a new table from the trigger drawer', async () => {
    // Two docs / three tables — the rebind target lives in a *different*
    // document than the currently bound table, so the test also covers
    // documentId capture (not just tableId).
    vi.mocked(listDataDocuments).mockResolvedValue({
      items: [
        {
          id: 'doc_1',
          title: 'Leads doc',
          tables: [{ id: 'tbl_1', title: 'Leads' }],
        },
        {
          id: 'doc_2',
          title: 'Founders doc',
          tables: [{ id: 'tbl_2', title: 'Founders' }],
        },
      ],
    } as any)

    await mount(createElement(WorkflowHomePage, { initialSelectedId: 'auto_1' }))

    // Open the trigger drawer by clicking the trigger node card on the
    // canvas. The card carries data-node-role="trigger" (see NodeCard) —
    // the click handler calls onSelect, which sets selectedNodeId and
    // opens the drawer.
    await act(async () => {
      container
        .querySelector('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const trigger = container.querySelector(
      '[data-testid="workflow-home-trigger-table"]',
    ) as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    // The currently bound table appears as the trigger button label.
    expect(trigger!.textContent).toContain('Leads')

    // Open the popover and click the row for tbl_2. The popover renders
    // into a portal (document.body), not container — query the body so
    // the row is reachable from this test.
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const optionRow = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((row) => row.textContent?.includes('Founders'))
    expect(optionRow).not.toBeUndefined()
    await act(async () => {
      optionRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(patchWorkflow).toHaveBeenCalledWith(
      'auto_1',
      expect.objectContaining({
        trigger: expect.objectContaining({
          tableId: 'tbl_2',
          documentId: 'doc_2',
        }),
      }),
    )
  })

  it('handles the create-mode chat pick by navigating to /workflow/new?mode=ai (no silent draft creation)', async () => {
    // Earlier iterations of this branch silently runScratch'd + popped the
    // assistant — that conjured an "Email someone on every new record"
    // template draft the user hadn't asked for. The route now resolves
    // no-context /workflow/new?mode=ai to the AI prompt page directly, so
    // we just navigate.
    const { createWorkflow } = await import('@/features/workflow/api')
    const { openWorkflowRoute } = await import('@/features/workflow/lib/openWorkflowRoute')
    const assistantEvents: CustomEvent[] = []
    const listener = (e: Event) => assistantEvents.push(e as CustomEvent)
    window.addEventListener('kition:assistant:open', listener)
    try {
      await mount(createElement(WorkflowHomePage))

      await act(async () => {
        container.querySelector('[data-testid="workflow-home-create"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        container.querySelector('[data-testid="mock-create-mode-chat"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(vi.mocked(createWorkflow as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      expect(vi.mocked(openWorkflowRoute)).toHaveBeenCalledWith(null, { mode: 'ai' })
      expect(assistantEvents).toHaveLength(0)
    } finally {
      window.removeEventListener('kition:assistant:open', listener)
    }
  })
})
