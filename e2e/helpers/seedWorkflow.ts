import type { Page, Route } from '@playwright/test'

/**
 * SeedWorkflowOptions configures the workflow seeding fixtures used
 * across the e2e suites for the P0/P1 workflow improvements. Each spec
 * picks the bits it needs (runs, nodes, sample row) without re-stubbing
 * the underlying GET routes.
 */
export type SeedWorkflowOptions = {
  id?: string
  name?: string
  enabled?: boolean
  trigger?: {
    nodeId?: string
    type?: 'record_created' | 'record_updated' | 'record_created_or_updated'
    tableId?: string
    documentId?: string
  }
  action?: {
    nodeId?: string
    connectionId?: string
    to?: string
    subject?: string
    body?: { parts: Array<{ kind: string; text?: string; fieldRef?: { nodeId: string; fieldId: string } }> }
  }
  nodes?: Array<{ nodeId: string; kind: 'trigger' | 'filter' | 'action'; config: Record<string, unknown> }>
  edges?: Array<{ from: string; to: string }>
  runs?: Array<Record<string, unknown>>
  patchResponder?: (body: unknown) => unknown
  retryResponder?: (runId: string) => unknown
}

export async function seedWorkflow(page: Page, options: SeedWorkflowOptions = {}) {
  const id = options.id ?? 'auto_seed'
  const triggerNodeId = options.trigger?.nodeId ?? 'trigger_1'
  const actionNodeId = options.action?.nodeId ?? 'action_1'
  const workflow = {
    id,
    name: options.name ?? 'Seeded Workflow',
    description: '',
    enabled: options.enabled ?? false,
    schemaVer: 2,
    trigger: {
      nodeId: triggerNodeId,
      type: options.trigger?.type ?? 'record_created',
      tableId: options.trigger?.tableId ?? 'tbl_leads',
      documentId: options.trigger?.documentId ?? 'doc_1',
    },
    action: {
      nodeId: actionNodeId,
      type: 'send_email',
      connectionId: options.action?.connectionId ?? 'conn_a',
      to: options.action?.to ?? 'team@example.com',
      subject: options.action?.subject ?? 'New Lead',
      body: options.action?.body ?? { parts: [{ kind: 'text', text: 'Hi team' }] },
    },
    nodes: options.nodes ?? [
      { nodeId: triggerNodeId, kind: 'trigger', config: { nodeId: triggerNodeId, type: options.trigger?.type ?? 'record_created', tableId: options.trigger?.tableId ?? 'tbl_leads' } },
      { nodeId: actionNodeId, kind: 'action', config: { nodeId: actionNodeId, type: 'send_email', to: options.action?.to ?? 'team@example.com' } },
    ],
    edges: options.edges ?? [{ from: triggerNodeId, to: actionNodeId }],
  }

  let currentWorkflow: Record<string, unknown> = workflow
  const runs = options.runs ?? []

  await page.route('**/v1/workflows', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [currentWorkflow] }) })
    }
    return route.continue()
  })
  await page.route(`**/v1/workflows/${id}`, async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      if (options.patchResponder) {
        const next = options.patchResponder(body)
        currentWorkflow = next as Record<string, unknown>
      } else {
        currentWorkflow = {
          ...currentWorkflow,
          ...body,
          action: { ...(currentWorkflow.action as Record<string, unknown>), ...(body.action as Record<string, unknown> ?? {}) },
        }
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: currentWorkflow }) })
    }
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentWorkflow) })
  })
  await page.route(`**/v1/workflows/${id}/runs**`, (route: Route) => {
    const url = new URL(route.request().url())
    const status = url.searchParams.get('status')
    const filtered = status && status !== 'all' ? runs.filter((r) => (r as { status?: string }).status === status) : runs
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: filtered }) })
  })
  await page.route(`**/v1/workflows/${id}/runs/*/retry`, (route: Route) => {
    const url = new URL(route.request().url())
    const segments = url.pathname.split('/')
    const runId = segments[segments.length - 2]
    const run = options.retryResponder ? options.retryResponder(runId) : { id: 'run_retry', workflowId: id, status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run }) })
  })
  await page.route(`**/v1/workflows/${id}/validate`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) }),
  )
  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: 'd', auth: 'password', fields: [] }]),
    }),
  )
  await page.route('**/v1/connections', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{
        id: 'conn_a', channel: 'email_smtp', name: 'Default SMTP',
        settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
        status: 'active', lastErrorMessage: '', usedByCount: 1,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }] }),
    }),
  )
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [
      { id: 'fld_priority', name: 'priority', title: 'Priority', type: 'single_select' },
      { id: 'fld_country', name: 'country', title: 'Country', type: 'text' },
      { id: 'fld_email', name: 'email', title: 'Email', type: 'email' },
    ], total: 3 } }) }),
  )
  await page.route('**/v1/data-documents', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'doc_1', title: 'Leads workspace', tables: [{ id: 'tbl_leads', title: 'Leads', name: 'leads' }] }] }),
    }),
  )
}
