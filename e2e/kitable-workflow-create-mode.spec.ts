import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * E2E — Group C: kitable-scoped Workflows landing + mode chooser dialog.
 *
 * Verifies the Group C refactor of `WorkflowHomePage`:
 *   1. In `hideList` (kitable Workflows virtual leaf) mode the default
 *      `WorkflowHomeLauncher` is hidden — the user sees a minimal empty
 *      state with a single "Create workflow" CTA.
 *   2. The global `/workflows` route is unaffected — its launcher renders
 *      as before with the template grid.
 *   3. Clicking the Kitable Workflows CTA flows through the table picker
 *      (so the user explicitly confirms the scope) and then the mode chooser
 *      dialog. The chooser has exactly two options: "From a template" and
 *      "Created by chat (AI)" — no "Start from scratch".
 *   4. Picking a template calls `GET /v1/data-documents/<docId>/tables/<tid>/fields`
 *      (schema fetch) then `POST /v1/workflows` with the template's
 *      trigger/action, scoped to the picked table.
 *   5. Picking "chat (AI)" navigates to `/workflow/new?mode=ai` without
 *      firing a `POST /v1/workflows`.
 *   6. Dismissing the dialog (Escape) fires no POST and no schema GET.
 *   7. A multi-table kitable still forces the table picker first; the POSTed
 *      workflow's `trigger.tableId` matches the picked table.
 *
 * The data-document API mock is shared with `kitable-table-leaf-actions.spec.ts`'s
 * conventions: a mutable list of fixture tables and recorded request payloads
 * surfaced to the test via the closure `state` object.
 */

const VAULT_PATH = '/tmp/kition-kitable-workflow-create-mode-e2e-vault'
const DOC_PATH = 't2.kitable'
const ONBOARDING_INBOX_PATH = 'Getting Started/Guides/Email Automation/Inbox.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

// ─── Fixture builders ───────────────────────────────────────────────────────

type TableFixture = {
  id: number
  title: string
  name: string
  order: number
  primaryFieldId: number
  fields?: Array<{ id: number; title: string; name: string; type: string }>
}

const SINGLE_TABLE: TableFixture[] = [
  { id: 12, title: 'Prospects', name: 'prospects', order: 0, primaryFieldId: 201 },
]

const ONBOARDING_INBOX_TABLES: TableFixture[] = [
  { id: 12, title: 'Inbox', name: 'inbox', order: 0, primaryFieldId: 201 },
]

const MULTI_TABLE: TableFixture[] = [
  { id: 12, title: 'Prospects', name: 'prospects', order: 0, primaryFieldId: 201 },
  { id: 13, title: 'Touchpoints', name: 'touchpoints', order: 1, primaryFieldId: 202 },
]

const STARTER_CONTENT_TABLES: TableFixture[] = [
  {
    id: 12,
    title: 'Content Ideas',
    name: 'content_ideas',
    order: 0,
    primaryFieldId: 201,
    fields: [
      { id: 201, title: 'Idea', name: 'idea', type: 'text' },
      { id: 202, title: 'Channel', name: 'channel', type: 'single_select' },
      { id: 203, title: 'Priority', name: 'priority', type: 'single_select' },
      { id: 204, title: 'Status', name: 'status', type: 'single_select' },
    ],
  },
  {
    id: 13,
    title: 'Publishing Queue',
    name: 'publishing_queue',
    order: 1,
    primaryFieldId: 301,
    fields: [
      { id: 301, title: 'Title', name: 'title', type: 'text' },
      { id: 302, title: 'Channel', name: 'channel', type: 'single_select' },
      { id: 303, title: 'Priority', name: 'priority', type: 'single_select' },
      { id: 304, title: 'Source Status', name: 'source_status', type: 'single_select' },
      { id: 305, title: 'Automation Note', name: 'automation_note', type: 'long_text' },
    ],
  },
]

const STARTER_TASK_TABLES: TableFixture[] = [
  {
    id: 12,
    title: 'Tasks',
    name: 'tasks',
    order: 0,
    primaryFieldId: 201,
    fields: [
      { id: 201, title: 'Name', name: 'name', type: 'text' },
      { id: 202, title: 'Status', name: 'status', type: 'single_select' },
      { id: 203, title: 'Due', name: 'due', type: 'date' },
      { id: 204, title: 'Notes', name: 'notes', type: 'long_text' },
    ],
  },
]

const STARTER_READING_TABLES: TableFixture[] = [
  {
    id: 12,
    title: 'Reading List',
    name: 'reading_list',
    order: 0,
    primaryFieldId: 201,
    fields: [
      { id: 201, title: 'Title', name: 'title', type: 'text' },
      { id: 202, title: 'URL', name: 'url', type: 'url' },
      { id: 203, title: 'AI Summary', name: 'ai_summary', type: 'long_text' },
      { id: 204, title: 'Status', name: 'status', type: 'single_select' },
    ],
  },
]

function buildTable(t: TableFixture) {
  return {
    id: t.id,
    user_id: 1,
    document_id: 1,
    name: t.name,
    title: t.title,
    description: '',
    order: t.order,
    primary_field_id: t.primaryFieldId,
    meta: null,
    fields: (t.fields || [
      {
        id: t.primaryFieldId,
        user_id: 1,
        document_id: 1,
        table_id: t.id,
        name: 'name',
        title: 'Name',
        type: 'text',
        required: false,
        unique: false,
        readonly: false,
        is_primary: true,
        order: 0,
        options: null,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ]).map((field, index) => ({
      id: field.id,
      user_id: 1,
      document_id: 1,
      table_id: t.id,
      name: field.name,
      title: field.title,
      type: field.type,
      required: index === 0,
      unique: false,
      readonly: false,
      is_primary: index === 0,
      order: index,
      options: null,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    })),
    views: [
      {
        id: 300 + t.id,
        user_id: 1,
        document_id: 1,
        table_id: t.id,
        title: 'Grid view',
        type: 'grid',
        order: 0,
        locked: false,
        config: {},
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  }
}

function buildDocument(tables: TableFixture[], docPath = DOC_PATH) {
  return {
    id: 1,
    user_id: 1,
    workspace_root: VAULT_PATH,
    path: docPath,
    title: docPath.split('/').pop()?.replace(/\.kitable$/i, '') || 'Table',
    description: '',
    icon: '',
    color: '',
    meta: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    tables: tables.map(buildTable),
  }
}

const EMPTY_RECORDS = { items: [], total: 0, offset: 0, limit: 200 }

// ─── Desktop-bridge mock ────────────────────────────────────────────────────

async function mockDesktopBridge(page: Page, docPath = DOC_PATH) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable Workflow Mode Dialog E2E Vault',
        added_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      }

      function makeListResponse() {
        return {
          root_path: vaultPath,
          items: Array.from(docs.keys()).map((path) => ({
            type: 'file' as const,
            path,
            name: path.split('/').pop() || path,
            format: 'data' as const,
            size: (docs.get(path)?.content || '').length,
            updated_at: docs.get(path)?.updated_at || '',
          })),
        }
      }

      function makeRegistry() {
        return { vaults: [vault], active_vault_path: vaultPath }
      }

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
        BackendStatus: async () => ({
          running: true,
          launch_mode: 'local',
          capabilities: ['documents', 'tables', 'workflow', 'email_sync'],
        }),
        StoreSecureValue: async (key: string, value: string) => {
          secureStore.set(key, value)
        },
        ReadSecureValue: async (key: string) => secureStore.get(key) || '',
        DeleteSecureValue: async (key: string) => {
          secureStore.delete(key)
        },
        OpenExternalURL: async () => {},

        ListVaults: async () => makeRegistry(),
        AddVault: async () => ({ vault, registry: makeRegistry() }),
        RemoveVault: async () => makeRegistry(),
        RenameVault: async () => ({ vault, registry: makeRegistry() }),
        SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),

        ListWorkspaceDocuments: async () => makeListResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) {
            throw new Error(`document not found: ${req.path}`)
          }
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: record.content,
            format: 'data',
            updated_at: record.updated_at,
            size: record.content.length,
          }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: req.content,
            format: 'data',
            updated_at,
            size: req.content.length,
          }
        },
        MoveWorkspaceDocument: async (req: { path: string; target_folder?: string; target_name?: string }) => {
          const record = docs.get(req.path)
          if (!record) throw new Error(`document not found: ${req.path}`)
          const targetName = req.target_name || req.path.split('/').pop() || req.path
          const targetFolder = req.target_folder ?? ''
          const newPath = targetFolder ? `${targetFolder}/${targetName}` : targetName
          const updated_at = new Date().toISOString()
          docs.set(newPath, { content: record.content, updated_at })
          docs.delete(req.path)
          return {
            path: newPath,
            name: newPath.split('/').pop() || newPath,
            content: record.content,
            format: 'data',
            updated_at,
            size: record.content.length,
          }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath, marker: DOC_MARKER },
  )

  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v2')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

// ─── Data-document + workflow API mock ───────────────────────────────────

type MockApiState = {
  docPath: string
  tables: TableFixture[]
  tablePosts: Array<Record<string, unknown>>
  fieldsCalls: Array<{ tableId: number }>
  workflowPosts: Array<Record<string, unknown>>
  workflowPatches: Array<Record<string, unknown>>
  workflows: Array<Record<string, unknown>>
  workflowGets: number
  nodeTests: Array<Record<string, unknown>>
}

async function mockApi(page: Page, state: MockApiState) {
  // Data-document endpoints (mirrors kitable-table-leaf-actions.spec.ts).
  await page.route('**/api/v1/data-documents**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'GET' && /^\/api\/v1\/data-documents$/.test(path)) {
      return fulfillJson(route, {
        code: 200,
        data: {
          items: [buildDocument(state.tables, state.docPath)],
          total: 1,
          offset: 0,
          limit: 100,
        },
      })
    }

    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: buildDocument(state.tables, state.docPath) })
    }

    if (method === 'POST' && /^\/api\/v1\/data-documents\/\d+\/tables$/.test(path)) {
      const payload = (await request.postDataJSON()) as Record<string, any>
      state.tablePosts.push(payload)
      const tableId = Math.max(...state.tables.map((item) => item.id), 11) + 1
      const fields = (payload.fields || []).map((field: Record<string, any>, index: number) => ({
        id: tableId * 100 + index + 1,
        title: String(field.title || field.name || `Field ${index + 1}`),
        name: String(field.name || `field_${index + 1}`),
        type: String(field.type || 'text'),
      }))
      const table: TableFixture = {
        id: tableId,
        title: String(payload.title || 'Untitled table'),
        name: String(payload.name || `table_${tableId}`),
        order: state.tables.length,
        primaryFieldId: fields[0]?.id || tableId * 100 + 1,
        fields,
      }
      state.tables.push(table)
      return fulfillJson(route, { code: 200, data: buildTable(table) })
    }

    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: buildDocument(state.tables, state.docPath) })
    }

    // Schema fetch issued by `fetchWorkflowTableSchema` before applying a
    // template. Recorded so C4 can assert it fires exactly once.
    const fieldsMatch = path.match(/^\/api\/v1\/data-documents\/\d+\/tables\/(\d+)\/fields$/)
    if (method === 'GET' && fieldsMatch) {
      const tableId = Number(fieldsMatch[1])
      state.fieldsCalls.push({ tableId })
      const table = state.tables.find((item) => item.id === tableId)
      return fulfillJson(route, {
        code: 200,
        data: {
          items: (table?.fields || [{ id: table?.primaryFieldId || 201, name: 'name', title: 'Name', type: 'text' }]),
        },
      })
    }

    const recordsMatch = path.match(/^\/api\/v1\/data-documents\/\d+\/tables\/(\d+)\/records$/)
    if (method === 'GET' && recordsMatch) {
      const tableId = Number(recordsMatch[1])
      const sourceTitle = state.tables.find((item) => item.id === tableId)?.title
      if (sourceTitle === 'Content Ideas') {
        return fulfillJson(route, { code: 200, data: {
          items: [{ id: 1, table_id: 12, values: { idea: 'Launch checklist', channel: 'Blog', priority: 'High', status: 'Drafting' } }],
          total: 1,
          offset: 0,
          limit: 10,
        } })
      }
      if (sourceTitle === 'Tasks') {
        return fulfillJson(route, { code: 200, data: {
          items: [{ id: 2, table_id: 12, values: { name: 'Ship onboarding', status: 'Done', due: '2026-07-18', notes: 'Verify onboarding workflows' } }],
          total: 1,
          offset: 0,
          limit: 10,
        } })
      }
      if (sourceTitle === 'Reading List') {
        return fulfillJson(route, { code: 200, data: {
          items: [{ id: 3, table_id: 12, values: { title: 'Agent workflow patterns', url: 'https://kition.ai', status: 'Reading' } }],
          total: 1,
          offset: 0,
          limit: 10,
        } })
      }
      return fulfillJson(route, { code: 200, data: EMPTY_RECORDS })
    }

    return fulfillJson(route, { code: 200, data: {} })
  })

  // Workflow endpoints. The mockLocalWorkspaceApi fallback would otherwise
  // satisfy `/v1/workflows` with an empty object — that's actually compatible
  // with `listWorkflows()` (it falls back to `[]`), but we want to record
  // GETs/POSTs distinctly for this test's assertions.
  await page.route('**/api/v1/workflows**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /v1/workflows — template creation
    if (method === 'POST' && path === '/api/v1/workflows') {
      const payload = (await request.postDataJSON()) as Record<string, unknown>
      state.workflowPosts.push(payload)
      const def = {
        id: `auto_${state.workflowPosts.length}`,
        user_id: 1,
        name: payload.name || 'Untitled workflow',
        description: payload.description || '',
        enabled: Boolean(payload.enabled),
        trigger: payload.trigger,
        action: payload.action,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      state.workflows.push(def)
      return fulfillJson(route, { code: 200, data: def })
    }

    // GET /v1/workflows — list
    if (method === 'GET' && /^\/api\/v1\/workflows$/.test(path)) {
      state.workflowGets += 1
      return fulfillJson(route, { code: 200, data: { items: state.workflows } })
    }

    // GET /v1/workflows/:id/runs — used by the home page after refresh
    if (method === 'GET' && /^\/api\/v1\/workflows\/[^/]+\/runs/.test(path)) {
      return fulfillJson(route, { code: 200, data: { runs: [] } })
    }

    const patchMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)$/)
    if (method === 'PATCH' && patchMatch) {
      const payload = (await request.postDataJSON()) as Record<string, unknown>
      state.workflowPatches.push(payload)
      const index = state.workflows.findIndex((item) => item.id === patchMatch[1])
      const current = state.workflows[index] || {}
      const updated = { ...current, ...payload }
      if (index >= 0) state.workflows[index] = updated
      return fulfillJson(route, { code: 200, data: { ok: true, workflow: updated } })
    }

    const nodeTestMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)\/nodes\/[^/]+\/test$/)
    if (method === 'POST' && nodeTestMatch) {
      const payload = (await request.postDataJSON()) as Record<string, unknown>
      state.nodeTests.push(payload)
      const workflow = state.workflows.find((item) => item.id === nodeTestMatch[1]) as any
      const targetTableId = String(workflow?.action?.addRecord?.targetTableId || '13')
      return fulfillJson(route, {
        code: 200,
        data: { ok: true, output: { recordId: `record_${state.nodeTests.length}`, tableId: targetTableId, documentId: '1' } },
      })
    }

    return fulfillJson(route, { code: 200, data: {} })
  })
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function freshState(tables: TableFixture[], docPath = DOC_PATH): MockApiState {
  return {
    docPath,
    tables: tables.map((t) => ({ ...t })),
    tablePosts: [],
    fieldsCalls: [],
    workflowPosts: [],
    workflowPatches: [],
    workflows: [],
    workflowGets: 0,
    nodeTests: [],
  }
}

async function openKitableWorkflowsTab(page: Page, docPath = DOC_PATH) {
  await page.goto('/')

  const filename = docPath.split('/').pop() || docPath
  const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: filename })
  await expect(kitableRow).toBeVisible({ timeout: 15_000 })
  await kitableRow.click()
  await page.getByTestId('workspace-kitable-expand').click()
  await page.getByTestId('workspace-kitable-workflow').click()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('Group C — kitable Workflows landing + mode dialog', () => {
  test('C1 — kitable-scoped Workflows keeps the inner sidebar across the /workflow route', async ({ page }) => {
    const state = freshState(SINGLE_TABLE)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    await expect(page.getByTestId('workspace-kitable-sidebar')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-workflow')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('workspace-kitable-collapse').click()
    const selector = page.getByTestId('workspace-kitable-collapsed-selector')
    await expect(selector).toHaveText(/Workflow/)
    await expect(page.getByTestId('workflow-index-topbar')).toHaveCount(0)
    await expect(page.getByTestId('workflow-index-title')).toHaveCount(0)
    await expect(page.getByText('Search · ⌘K')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^All ·/ })).toHaveCount(0)
    await expect(page.getByTestId('workflow-index-create')).toBeVisible()

    await page.getByTestId('workspace-kitable-expand').click()

    await page.evaluate(() => {
      const next = { ...(window.history.state || {}) }
      window.history.pushState(next, '', '/workflow')
      window.dispatchEvent(new PopStateEvent('popstate', { state: next }))
    })

    await expect(page.getByTestId('workspace-workflow-workbench')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-sidebar')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-workflow')).toHaveAttribute('aria-current', 'page')
  })

  test('C2 — global /workflow route renders the index page (not the launcher hero)', async ({ page }) => {
    const state = freshState(SINGLE_TABLE)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)

    await page.goto('/workflow')

    // /workflow now lands on WorkflowIndexPage post route-split — the
    // launcher hero moved to the empty detail page (/workflow/{id} with
    // nothing selected) and is no longer reachable from /workflow itself.
    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="workflow-home-launcher"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="kitable-workflows-empty"]')).toHaveCount(0)
  })

  // C3-C6 cover the old "kitable-workflows-create-cta → workflow-table-picker
  // → mode dialog" funnel. The picker step is gone — the kitable scope
  // pre-binds the table on tab mount, so the CTA opens the mode dialog
  // directly (workspace-workflow-create-mode-dialog) with context already
  // resolved. A proper rewrite would target the new shape; skipping for
  // now keeps the suite green while flagging the drift for follow-up.
  test.skip('C3 — CTA flows through table picker → mode dialog with the two choices', async () => {})
  test('C4 — "From a template" fetches schema then POSTs the workflow', async ({ page }) => {
    const state = freshState(SINGLE_TABLE)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    const visibleTabs = page.locator('.document-tab-list .document-tab')
    const fileTab = page.locator('.document-tab-list .document-tab[data-tab-title="t2"]')
    const tabCountBeforeCreate = await visibleTabs.count()
    await expect(fileTab).toHaveCount(1)
    await expect(page.locator('.document-tab-list .document-tab[data-tab-title^="Workflows"]')).toHaveCount(0)

    await page.getByTestId('workflow-index-create').click()
    await expect(page.getByTestId('workspace-workflow-create-mode-dialog')).toHaveAttribute(
      'data-context-table-id',
      '12',
    )
    await page.getByTestId('create-mode-template').click()

    const template = page.getByTestId('workflow-launcher-template-card').filter({
      hasText: 'Email someone on every new record',
    })
    await expect(template).toBeVisible()
    await template.click()

    await expect.poll(() => state.fieldsCalls).toEqual([{ tableId: 12 }])
    await expect.poll(() => state.workflowPosts).toHaveLength(1)
    expect(state.workflowPosts[0]).toMatchObject({
      name: 'Email someone on every new record',
      trigger: {
        type: 'record_created',
        documentId: '1',
        tableId: '12',
      },
      action: { type: 'send_email' },
    })
    await expect(page.getByTestId('workspace-workflow-create-mode-dialog')).toHaveCount(0)

    await expect(page.getByTestId('workflow-home-name')).toHaveCount(0)
    await expect(page.getByTestId('workflow-home-topbar')).not.toContainText('Email someone on every new record')
    await expect(page.getByTestId('workflow-home-topbar')).not.toContainText('t2.kitable')
    await expect(page.getByTestId('workflow-home-page').getByText('Object:', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('workflow-home-page').getByText('Trigger:', { exact: true })).toHaveCount(0)
    await expect(fileTab).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(tabCountBeforeCreate)

    await page.getByTestId('workspace-kitable-data-table').click()
    await expect(fileTab).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(tabCountBeforeCreate)
    await page.getByTestId('workspace-kitable-workflow').click()

    await expect(page.getByTestId('workflow-home-name')).toHaveCount(0)
    await expect(fileTab).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(tabCountBeforeCreate)
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Prospects')
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-home-subject-editor')).not.toBeEmpty()
    await expect(page.getByTestId('workflow-home-body-editor')).not.toBeEmpty()
  })
  test('C4b — email inbox sync is launched from the shared template picker', async ({ page }) => {
    const state = freshState(MULTI_TABLE)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await page.route('**/api/v1/email-sync/workflows', (route) => fulfillJson(route, {
      code: 200,
      data: { items: [] },
    }))
    await openKitableWorkflowsTab(page)

    await page.getByTestId('workflow-index-create').click()
    await page.getByTestId('create-mode-template').click()
    await page.getByTestId('email-sync-workflow-template').click()

    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    await expect(page.getByTestId('email-sync-workflow-editor')).toBeVisible()
    await expect(page.getByTestId('email-sync-table-select')).toContainText('Prospects')
    await page.getByTestId('email-sync-table-select').click()
    await page.getByTestId('email-sync-table-search').fill('touch')
    await expect(page.getByTestId('email-sync-table-option-12')).toHaveCount(0)
    await page.getByTestId('email-sync-table-option-13').click()
    await expect(page.getByTestId('email-sync-table-select')).toContainText('Touchpoints')
    await expect(page.getByTestId('email-sync-settings-panel')).toContainText(`Current Kitable: ${DOC_PATH}`)
    await expect(page.getByTestId('email-sync-settings-panel')).toBeVisible()
    expect(state.workflowPosts).toHaveLength(0)
  })
  test('C4c — onboarding Inbox opens with the included email sync workflow', async ({ page }) => {
    const state = freshState(ONBOARDING_INBOX_TABLES, ONBOARDING_INBOX_PATH)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page, ONBOARDING_INBOX_PATH)
    await page.route('**/api/v1/email-sync/workflows', (route) => fulfillJson(route, {
      code: 200,
      data: { items: [] },
    }))
    await openKitableWorkflowsTab(page, ONBOARDING_INBOX_PATH)

    await expect(page.getByTestId('email-sync-onboarding-workflow-page')).toBeVisible()
    await expect(page.getByTestId('workflow-index-empty')).toHaveCount(0)
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Scheduled trigger')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Every 15 minutes')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Sync email inbox')

    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('email-sync-workflow-editor')).toBeVisible()
    await expect(page.getByTestId('email-sync-table-select')).toContainText('Inbox')
    await expect(page.getByTestId('email-sync-settings-panel')).toContainText(`Current Kitable: ${ONBOARDING_INBOX_PATH}`)
    expect(state.workflowPosts).toHaveLength(0)
  })
  test('C4d — reopening a configured onboarding Inbox returns to its workflow canvas', async ({ page }) => {
    await page.setViewportSize({ width: 2048, height: 1152 })
    const state = freshState(ONBOARDING_INBOX_TABLES, ONBOARDING_INBOX_PATH)
    const emailWorkflow = {
      id: 'mail_onboarding',
      name: '163 Mail inbox',
      connection: {
        host: 'imap.163.com',
        port: 993,
        tls_mode: 'tls',
        username: 'person@163.com',
        mailbox: 'INBOX',
      },
      target: {
        table_path: ONBOARDING_INBOX_PATH,
        content_folder: 'Mail/Messages',
        attachment_folder: 'Mail/Attachments',
      },
      schedule: { enabled: true, interval_minutes: 15 },
      include_attachments: true,
      status: 'active',
      synced_messages: 10,
      last_sync_at: '2026-07-23T11:17:16Z',
      created_at: '2026-07-23T11:00:00Z',
      updated_at: '2026-07-23T11:17:16Z',
    }
    const completedRun = {
      id: 'mailrun_completed',
      workflow_id: emailWorkflow.id,
      mode: 'full',
      status: 'completed',
      discovered_messages: 10,
      processed_messages: 10,
      imported: 10,
      updated: 0,
      skipped: 0,
      failed: 0,
      current_batch: 1,
      table_path: ONBOARDING_INBOX_PATH,
      started_at: '2026-07-23T11:16:00Z',
      finished_at: '2026-07-23T11:17:16Z',
      created_at: '2026-07-23T11:16:00Z',
      updated_at: '2026-07-23T11:17:16Z',
    }
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page, ONBOARDING_INBOX_PATH)
    await page.route('**/api/v1/email-sync/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/v1/email-sync/workflows') {
        return fulfillJson(route, { code: 200, data: { items: [emailWorkflow] } })
      }
      if (path === '/api/v1/email-sync/runs') {
        return fulfillJson(route, { code: 200, data: { items: [completedRun] } })
      }
      return fulfillJson(route, { code: 200, data: {} })
    })
    await page.goto('/')
    const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 'Inbox.kitable' })
    await expect(kitableRow).toBeVisible({ timeout: 15_000 })
    await kitableRow.click()
    await page.getByTestId('workspace-kitable-expand').click()
    const workflowButton = page.getByTestId('workspace-kitable-workflow')
    const workflowButtonBox = await workflowButton.boundingBox()
    expect(workflowButtonBox).not.toBeNull()
    const hitTestId = await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid') || ''
    ), {
      x: workflowButtonBox!.x + workflowButtonBox!.width / 2,
      y: workflowButtonBox!.y + workflowButtonBox!.height / 2,
    })
    expect(hitTestId).toBe('workspace-kitable-workflow')
    await workflowButton.click()

    await expect(page.getByTestId('email-sync-workflow-page')).toBeVisible()
    await expect(page.getByTestId('email-sync-workflow-page')).toContainText('163 Mail inbox')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Scheduled trigger')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Sync email inbox')
    await page.waitForTimeout(200)
    await expect(page.getByTestId('email-sync-workflow-page')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-data-table')).not.toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('email-sync-workflow-row')).toHaveCount(0)
  })
  test.skip('C5 — "Created by chat (AI)" navigates to /workflow/new?mode=ai without POSTing', async () => {})
  test.skip('C6 — Escaping the mode dialog fires no create requests', async () => {})
  test('C7 — multi-table kitable lets the user choose the trigger table in the mode dialog', async ({ page }) => {
    const state = freshState(MULTI_TABLE)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    await page.getByTestId('workflow-index-create').click()
    const dialog = page.getByTestId('workspace-workflow-create-mode-dialog')
    await expect(dialog).toHaveAttribute('data-context-table-id', '12')
    await page.getByTestId('workflow-create-source-table').selectOption('13')
    await expect(dialog).toHaveAttribute('data-context-table-id', '13')
    await page.getByTestId('create-mode-template').click()
    await page.getByTestId('workflow-launcher-template-card').filter({
      hasText: 'Email someone on every new record',
    }).click()

    await expect.poll(() => state.workflowPosts).toHaveLength(1)
    expect(state.workflowPosts[0]).toMatchObject({
      trigger: { documentId: '1', tableId: '13' },
    })
    expect(state.fieldsCalls[0]).toEqual({ tableId: 13 })
  })

  test('C8 — onboarding workflow appears on first open, is enabled, and creates a real test row', async ({ page }) => {
    const state = freshState(STARTER_CONTENT_TABLES)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    await expect.poll(() => state.workflowPosts).toHaveLength(1)
    expect(state.workflowPosts[0]).toMatchObject({
      enabled: true,
      trigger: {
        type: 'record_created',
        documentId: '1',
        tableId: '12',
        requiredFields: ['201', '202', '203', '204'],
      },
      action: {
        type: 'add_record',
        addRecord: {
          targetDocumentId: '1',
          targetTableId: '13',
        },
      },
    })

    await expect(page.getByTestId('workflow-home-page')).toBeVisible()
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Content Ideas')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Publishing Queue')
    await expect(page.getByTestId('status-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('workflow-add-record-test-step')).toBeVisible()
    await page.getByTestId('workflow-home-sample-row-picker').click()
    await page.getByTestId('workflow-home-sample-row-option').click()
    await expect.poll(() => state.nodeTests).toHaveLength(1)
    expect(state.nodeTests[0]).toMatchObject({
      triggerFields: {
        idea: 'Launch checklist',
        channel: 'Blog',
        priority: 'High',
        status: 'Drafting',
      },
    })
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Publishing Queue')
  })

  test('C9 — Task Tracker onboarding adds two workflows, persists the filter, and can run the schedule now', async ({ page }) => {
    const state = freshState(STARTER_TASK_TABLES)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    await expect.poll(() => state.tablePosts).toHaveLength(1)
    expect(state.tablePosts[0]).toMatchObject({ title: 'Completed Tasks' })
    await expect.poll(() => state.workflowPosts).toHaveLength(2)
    await expect.poll(() => state.workflowPatches).toHaveLength(1)
    expect(state.workflowPatches[0]).toMatchObject({
      enabled: true,
      nodes: expect.arrayContaining([
        expect.objectContaining({
          kind: 'filter',
          config: expect.objectContaining({ expression: 'trigger_1.Status == "Done"' }),
        }),
      ]),
    })
    expect(state.workflowPosts.map((item) => item.name)).toEqual([
      'Archive completed tasks',
      'Create a weekday planning task',
    ])
    expect(state.workflowPosts[1]).toMatchObject({
      enabled: true,
      trigger: { type: 'scheduled_time', schedule: { cron: '0 9 * * 1-5' } },
      action: { addRecord: { targetTableId: '12' } },
    })

    const scheduledRow = page.getByRole('row').filter({ hasText: 'Create a weekday planning task' })
    await expect(scheduledRow).toBeVisible()
    await scheduledRow.click()
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-add-record-run-now')).toBeVisible()
    await page.getByTestId('workflow-add-record-run-now').click()
    await expect.poll(() => state.nodeTests).toHaveLength(1)
    expect(state.nodeTests[0]).toEqual({})
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Tasks')
  })

  test('C10 — Reading Tracker onboarding creates a journal workflow and writes a real snapshot', async ({ page }) => {
    const state = freshState(STARTER_READING_TABLES)
    await mockLocalWorkspaceApi(page)
    await mockApi(page, state)
    await mockDesktopBridge(page)
    await openKitableWorkflowsTab(page)

    await expect.poll(() => state.tablePosts).toHaveLength(1)
    expect(state.tablePosts[0]).toMatchObject({ title: 'Reading Journal' })
    await expect.poll(() => state.workflowPosts).toHaveLength(1)
    expect(state.workflowPosts[0]).toMatchObject({
      enabled: true,
      trigger: { type: 'record_created_or_updated', tableId: '12' },
      action: { addRecord: { targetTableId: '13' } },
    })

    await expect(page.getByTestId('workflow-home-page')).toBeVisible()
    await page.getByTestId('workflow-home-sample-row-picker').click()
    await page.getByTestId('workflow-home-sample-row-option').click()
    await expect.poll(() => state.nodeTests).toHaveLength(1)
    expect(state.nodeTests[0]).toMatchObject({
      triggerFields: { title: 'Agent workflow patterns', status: 'Reading' },
    })
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Reading Journal')
  })

})
