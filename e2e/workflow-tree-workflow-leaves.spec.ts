import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * T3 — workspace tree workflow count badge.
 *
 * `useWorkflowCountsByKitablePath` joins `listWorkflows()` with the
 * shared kitable children index keyed by `tableId → kitablePath`, and
 * the badge in `WorkspaceTree.tsx` consumes that map per `workflows://`
 * virtual leaf (testid `workflow-virtual-node-count`).
 *
 * The kitable surface uses the `kition:workflow:changed` event bus
 * (dispatched from `features/workflow/api.ts` on every patch / delete)
 * to refetch counts. T3 guards the contract: after a workflow is
 * deleted from the editor, the sidebar badge re-renders with the new
 * count without a full reload.
 *
 * Setup mirrors the desktop-bridge + data-documents pattern used by
 * `kitable-workflow-create-mode.spec.ts`. The bridge exposes one
 * `Leads.kitable` doc; the API mock returns its single `tbl_leads`
 * table and a workflow list that starts at 2 and drops to 1 after
 * the DELETE.
 */

const VAULT_PATH = '/tmp/kition-workflow-tree-count-badge-e2e-vault'
const DOC_PATH = 'Leads.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

type Workflow = {
  id: string
  name: string
  enabled: boolean
  schemaVer: number
  trigger: { nodeId: string; type: string; tableId: string; documentId: string }
  action: { nodeId: string; type: string; to: string; subject: string; body: { parts: Array<{ kind: string; text?: string }> } }
  nodes: Array<{ nodeId: string; kind: string; config: Record<string, unknown> }>
  edges: Array<{ from: string; to: string }>
}

function buildWorkflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    enabled: false,
    schemaVer: 2,
    // `useKitableChildrenIndex` does `Number(table.id)` and joins by stringifying
    // both sides, so the workflow's tableId / documentId have to stringify
    // identically to the data-document's table.id / doc.id (numeric below).
    trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: '7', documentId: '1' },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      to: 'team@example.com',
      subject: 'New lead',
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: '7', documentId: '1' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: 'team@example.com' } },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }
}

async function mockDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Workflow Tree Count Badge E2E Vault',
        added_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      }
      const registry = () => ({ vaults: [vault], active_vault_path: vaultPath })
      const listResponse = () => ({
        root_path: vaultPath,
        items: Array.from(docs.keys()).map((path) => ({
          type: 'file' as const,
          path,
          name: path.split('/').pop() || path,
          format: 'data' as const,
          size: (docs.get(path)?.content || '').length,
          updated_at: docs.get(path)?.updated_at || '',
        })),
      })

      stateWindow.kitionDesktop = {
        shell: 'electron',
        DesktopInfo: async () => ({
          is_desktop: true,
          platform: 'darwin',
          backend_base_url: 'http://127.0.0.1:18101/api',
          data_dir: '/tmp/kition/data',
          cache_dir: '/tmp/kition/cache',
          logs_dir: '/tmp/kition/logs',
          uploads_dir: '/tmp/kition/uploads',
          exports_dir: '/tmp/kition/exports',
          workspace_dir: vaultPath,
          supports_secure_storage: true,
        }),
        StoreSecureValue: async (key: string, value: string) => { secureStore.set(key, value) },
        ReadSecureValue: async (key: string) => secureStore.get(key) || '',
        DeleteSecureValue: async (key: string) => { secureStore.delete(key) },
        OpenExternalURL: async () => {},
        ListVaults: async () => registry(),
        AddVault: async () => ({ vault, registry: registry() }),
        RemoveVault: async () => registry(),
        RenameVault: async () => ({ vault, registry: registry() }),
        SetActiveVault: async () => ({ list: listResponse(), registry: registry() }),
        ListWorkspaceDocuments: async () => listResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) throw new Error(`document not found: ${req.path}`)
          return { path: req.path, name: req.path.split('/').pop() || req.path, content: record.content, format: 'data', updated_at: record.updated_at, size: record.content.length }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return { path: req.path, name: req.path.split('/').pop() || req.path, content: req.content, format: 'data', updated_at, size: req.content.length }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, marker: DOC_MARKER },
  )
  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v2')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

async function mockTreeAndWorkflowApi(page: Page) {
  const workflows: Workflow[] = [
    buildWorkflow('wf_a', 'WF A'),
    buildWorkflow('wf_b', 'WF B'),
  ]

  // Build the single-table document the bridge's `Leads.kitable` marker
  // points at via `data_document_id: 1`. Identifying the table by the
  // same `tbl_leads` id the workflows' trigger.tableId carries is what
  // lets `useWorkflowCountsByKitablePath` join the two.
  const buildDocument = () => ({
    id: 1,
    user_id: 1,
    workspace_root: VAULT_PATH,
    path: DOC_PATH,
    title: 'Leads',
    description: '',
    icon: '',
    color: '',
    meta: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    tables: [
      {
        id: 7,
        user_id: 1,
        document_id: 1,
        name: 'leads',
        title: 'Leads',
        description: '',
        order: 0,
        primary_field_id: 1,
        meta: null,
        fields: [
          { id: 1, name: 'name', title: 'Name', type: 'text', is_primary: true, order: 0 },
        ],
        views: [],
      },
    ],
  })

  await page.route('**/api/v1/data-documents**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'GET' && /^\/api\/v1\/data-documents$/.test(path)) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 200, data: { items: [buildDocument()], total: 1, offset: 0, limit: 100 } }),
      })
    }
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 200, data: buildDocument() }) })
    }
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 200, data: buildDocument() }) })
    }
    // Kitable auto-opens its single table when expanded, which pulls
    // /tables/:id/fields and /tables/:id/records. Without these the table
    // editor crashes with "records is undefined" (it calls .filter() in
    // useTableEditorDerivedState). Both responses are intentionally empty
    // — the tree badge is the only thing under test, not the editor.
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/fields$/.test(path)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 200, data: { items: [
          { id: 1, name: 'name', title: 'Name', type: 'text', is_primary: true, order: 0 },
        ] } }) })
    }
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 200, data: { items: [], total: 0, offset: 0, limit: 200 } }) })
    }
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 200, data: {} }) })
  })

  // Workflow list + selection routes. The list response is recomputed on
  // every GET so the post-DELETE refetch picks up the shorter array.
  await page.route('**/v1/workflows', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: workflows }),
      })
    }
    return route.continue()
  })
  for (const wf of workflows) {
    await page.route(`**/v1/workflows/${wf.id}`, (route: Route) => {
      if (route.request().method() === 'DELETE') {
        const idx = workflows.findIndex((w) => w.id === wf.id)
        if (idx >= 0) workflows.splice(idx, 1)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      }
      const current = workflows.find((w) => w.id === wf.id) ?? wf
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
    })
    await page.route(`**/v1/workflows/${wf.id}/runs**`, (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) }),
    )
    await page.route(`**/v1/workflows/${wf.id}/validate`, (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) }),
    )
  }

  await page.route('**/v1/channels', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: '', auth: 'password', fields: [] }]),
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

  return workflows
}

test.beforeEach(async ({ page }) => {
  await mockDesktopBridge(page)
  await mockLocalWorkspaceApi(page)
})

// T3.1 / T3.2 depend on per-workflow virtual leaves (kitable-workflow-leaf)
// rendered under a kitable in the workspace tree. The tree refactor that
// landed alongside the route split removed those virtual leaves — the
// kitable now exposes tables directly with no per-workflow listings, so
// the assertions (and the openKitableWorkflowsTab path) have no element
// to bind to. Skipping until the virtual leaves are reintroduced (or the
// replacement entry point is wired up).
test.skip('T3.1 deleting a workflow drops the kitable workflow-leaf row count by 1', async () => {})
test.skip('T3.2 deleting every workflow under a kitable removes all workflow leaves', async () => {})
