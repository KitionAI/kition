import { expect, test, type Page } from '@playwright/test'

import { kitTableFile, mockKitTables, type KitTableFixture, type KitTablesMockState } from './helpers/kitTables'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * The workflows of one `.ktable` file, as a workspace tab of their own.
 *
 *   1. The tree's create menu on a table file opens its workflow tab; the
 *      tab lists only workflows bound to that file.
 *   2. The global `/workflow` route renders the index page, not the tab.
 *   3. Creating a workflow from a template in the tab fetches the table's
 *      schema through `/v1/kit-tables/fields` and POSTs the workflow bound to
 *      the file (`trigger.documentPath`) and the picked table.
 *   4. A multi-table file lets the person pick the trigger table.
 *   5. The onboarding Inbox opens on its email sync workflow canvas.
 *   6. Onboarding table files materialise their runnable workflows on first
 *      open (creating missing target tables through `/v1/kit-tables/tables`).
 */

const VAULT_PATH = '/tmp/kition-table-file-workflows-e2e-vault'
const DOC_PATH = 't2.ktable'
const ONBOARDING_INBOX_PATH = 'Getting Started/Guides/Email Automation/Inbox.ktable'

const SINGLE_TABLE: KitTableFixture[] = [
  { id: '12', title: 'Prospects' },
]

const ONBOARDING_INBOX_TABLES: KitTableFixture[] = [
  { id: '12', title: 'Inbox' },
]

const MULTI_TABLE: KitTableFixture[] = [
  { id: '12', title: 'Prospects' },
  { id: '13', title: 'Touchpoints' },
]

const STARTER_CONTENT_TABLES: KitTableFixture[] = [
  {
    id: '12',
    title: 'Content Ideas',
    fields: [
      { id: 'fld_idea', title: 'Idea', name: 'idea', type: 'text' },
      { id: 'fld_channel', title: 'Channel', name: 'channel', type: 'single_select' },
      { id: 'fld_priority', title: 'Priority', name: 'priority', type: 'single_select' },
      { id: 'fld_status', title: 'Status', name: 'status', type: 'single_select' },
    ],
    records: [{ id: 1, values: { idea: 'Launch checklist', channel: 'Blog', priority: 'High', status: 'Drafting' } }],
  },
  {
    id: '13',
    title: 'Publishing Queue',
    fields: [
      { id: 'fld_title', title: 'Title', name: 'title', type: 'text' },
      { id: 'fld_q_channel', title: 'Channel', name: 'channel', type: 'single_select' },
      { id: 'fld_q_priority', title: 'Priority', name: 'priority', type: 'single_select' },
      { id: 'fld_source_status', title: 'Source Status', name: 'source_status', type: 'single_select' },
      { id: 'fld_note', title: 'Automation Note', name: 'automation_note', type: 'long_text' },
    ],
  },
]

const STARTER_TASK_TABLES: KitTableFixture[] = [
  {
    id: '12',
    title: 'Tasks',
    fields: [
      { id: 'fld_name', title: 'Name', name: 'name', type: 'text' },
      { id: 'fld_status', title: 'Status', name: 'status', type: 'single_select' },
      { id: 'fld_due', title: 'Due', name: 'due', type: 'date' },
      { id: 'fld_notes', title: 'Notes', name: 'notes', type: 'long_text' },
    ],
    records: [{ id: 2, values: { name: 'Ship onboarding', status: 'Done', due: '2026-07-18', notes: 'Verify onboarding workflows' } }],
  },
]

const STARTER_READING_TABLES: KitTableFixture[] = [
  {
    id: '12',
    title: 'Reading List',
    fields: [
      { id: 'fld_title', title: 'Title', name: 'title', type: 'text' },
      { id: 'fld_url', title: 'URL', name: 'url', type: 'url' },
      { id: 'fld_summary', title: 'AI Summary', name: 'ai_summary', type: 'long_text' },
      { id: 'fld_status', title: 'Status', name: 'status', type: 'single_select' },
    ],
    records: [{ id: 3, values: { title: 'Agent workflow patterns', url: 'https://kition.ai', status: 'Reading' } }],
  },
]

// ─── Desktop-bridge mock ────────────────────────────────────────────────────

async function mockDesktopBridge(page: Page, docPath = DOC_PATH) {
  await page.addInitScript(
    ({ vaultPath, docPath }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const updatedAt = new Date().toISOString()
      const vault = {
        path: vaultPath,
        name: 'Table File Workflows E2E Vault',
        added_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      }
      const makeListResponse = () => ({
        root_path: vaultPath,
        items: [{
          type: 'file' as const,
          path: docPath,
          name: docPath.split('/').pop() || docPath,
          format: 'table' as const,
          size: 2048,
          updated_at: updatedAt,
        }],
      })
      const makeRegistry = () => ({ vaults: [vault], active_vault_path: vaultPath })

      stateWindow.kitionDesktop = {
        shell: 'tauri',
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
          base_url: 'http://127.0.0.1:18101/api',
          health_url: 'http://127.0.0.1:18101/health',
          running: true,
          last_error: '',
          logs: '',
          log_file: '',
          launch_mode: 'local',
          binary_path: '',
          config_path: '',
          working_dir: '',
          command: '',
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
        ReadWorkspaceDocument: async (request: { path: string }) => {
          throw new Error(`a table file is not text-editable: ${request.path}`)
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath },
  )

  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v2')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

// ─── Workflow API mock ──────────────────────────────────────────────────────

type WorkflowMockState = {
  workflowPosts: Array<Record<string, any>>
  workflowPatches: Array<Record<string, any>>
  workflows: Array<Record<string, any>>
  nodeTests: Array<Record<string, unknown>>
}

async function mockWorkflowApi(page: Page): Promise<WorkflowMockState> {
  const state: WorkflowMockState = { workflowPosts: [], workflowPatches: [], workflows: [], nodeTests: [] }
  await page.route('**/api/v1/workflows**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()

    if (method === 'POST' && path === '/api/v1/workflows') {
      const payload = request.postDataJSON() as Record<string, any>
      state.workflowPosts.push(payload)
      const def = {
        id: `auto_${state.workflowPosts.length}`,
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
    if (method === 'GET' && path === '/api/v1/workflows') {
      return fulfillJson(route, { code: 200, data: { items: state.workflows } })
    }
    if (method === 'GET' && /^\/api\/v1\/workflows\/[^/]+\/runs/.test(path)) {
      return fulfillJson(route, { code: 200, data: { runs: [] } })
    }
    const patchMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)$/)
    if (method === 'PATCH' && patchMatch) {
      const payload = request.postDataJSON() as Record<string, any>
      state.workflowPatches.push(payload)
      const index = state.workflows.findIndex((item) => item.id === patchMatch[1])
      const updated = { ...(state.workflows[index] || {}), ...payload }
      if (index >= 0) state.workflows[index] = updated
      return fulfillJson(route, { code: 200, data: { ok: true, workflow: updated } })
    }
    const nodeTestMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)\/nodes\/[^/]+\/test$/)
    if (method === 'POST' && nodeTestMatch) {
      state.nodeTests.push(request.postDataJSON() as Record<string, unknown>)
      const workflow = state.workflows.find((item) => item.id === nodeTestMatch[1])
      const addRecord = workflow?.action?.addRecord
      const targetTableId = String(addRecord?.targetTableId || '')
      const documentPath = addRecord?.targetDocumentPath || workflow?.trigger?.documentPath
      return fulfillJson(route, {
        code: 200,
        data: { ok: true, output: { recordId: `record_${state.nodeTests.length}`, tableId: targetTableId, documentPath } },
      })
    }
    return fulfillJson(route, { code: 200, data: {} })
  })
  return state
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

async function setup(page: Page, tables: KitTableFixture[], docPath = DOC_PATH): Promise<{ tables: KitTablesMockState; api: WorkflowMockState }> {
  await mockLocalWorkspaceApi(page)
  const tableState = await mockKitTables(page, [kitTableFile(docPath, tables.map((table) => ({ ...table, fields: table.fields?.map((field) => ({ ...field })) })))])
  const api = await mockWorkflowApi(page)
  await mockDesktopBridge(page, docPath)
  return { tables: tableState, api }
}

function treeRow(page: Page, docPath: string) {
  const title = (docPath.split('/').pop() || docPath).replace(/\.ktable$/i, '')
  return page.locator('.document-tree-row.document-tree-page', { hasText: title }).first()
}

/** Opens a table file's workflow tab from the tree row's create menu. */
async function openTableFileWorkflowsTab(page: Page, docPath = DOC_PATH) {
  await page.goto('/')
  const row = treeRow(page, docPath)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.hover()
  await row.getByRole('button', { name: 'Create inside this page' }).click()
  await page.getByTestId('table-file-action-create-workflow').click()
  await expect(page.locator(`[data-testid="workspace-workflow-workbench"][data-workflow-tab-id="workflow:${docPath}"]`)).toHaveCount(1)
  await expect(page.locator('.document-tab-list .document-tab', { hasText: 'Workflows' })).toHaveClass(/is-active/)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('table file workflows tab', () => {
  test('the tree opens a table file workflow tab with its empty workflow list', async ({ page }) => {
    await setup(page, SINGLE_TABLE)
    await openTableFileWorkflowsTab(page)

    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('workflow-index-empty')).toBeVisible()
    await expect(page.getByTestId('workflow-index-create')).toBeVisible()
  })

  test('choosing Workflow on a table file keeps the new workflow tab active', async ({ page }) => {
    await setup(page, SINGLE_TABLE)
    await page.goto('/')
    const row = treeRow(page, DOC_PATH)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()
    await row.getByRole('button', { name: 'Create inside this page' }).click()
    await page.getByTestId('table-file-action-create-workflow').click()
    await expect(page.locator('.document-tab-list .document-tab.is-active')).toHaveAttribute('data-tab-title', 'Workflows')
    await expect(page.getByTestId('workflow-index-page')).toBeVisible()
  })

  test('the global /workflow route renders the index page (not the launcher hero)', async ({ page }) => {
    await setup(page, SINGLE_TABLE)
    await page.goto('/workflow')

    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="workflow-home-launcher"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="table-file-workflows-empty"]')).toHaveCount(0)
  })

  test('"From a template" fetches the table schema then POSTs a workflow bound to the file', async ({ page }) => {
    const { tables, api } = await setup(page, SINGLE_TABLE)
    await openTableFileWorkflowsTab(page)

    await page.getByTestId('workflow-index-create').click()
    await expect(page.getByTestId('workspace-workflow-create-mode-dialog')).toHaveAttribute('data-context-table-id', '12')
    await expect(page.getByTestId('workspace-workflow-create-mode-dialog')).toHaveAttribute('data-context-document-path', DOC_PATH)
    await page.getByTestId('create-mode-template').click()
    await page.getByTestId('workflow-launcher-template-card').filter({ hasText: 'Email someone on every new record' }).click()

    await expect.poll(() => tables.fieldsCalls).toEqual([{ path: DOC_PATH, tableId: '12' }])
    await expect.poll(() => api.workflowPosts).toHaveLength(1)
    expect(api.workflowPosts[0]).toMatchObject({
      name: 'Email someone on every new record',
      trigger: { type: 'record_created', documentPath: DOC_PATH, tableId: '12' },
      action: { type: 'send_email' },
    })
    await expect(page.getByTestId('workspace-workflow-create-mode-dialog')).toHaveCount(0)
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Prospects')
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('workflow-home-subject-editor')).not.toBeEmpty()
    await expect(page.getByTestId('workflow-home-body-editor')).not.toBeEmpty()
  })

  test('a multi-table file lets the person choose the trigger table in the mode dialog', async ({ page }) => {
    const { tables, api } = await setup(page, MULTI_TABLE)
    await openTableFileWorkflowsTab(page)

    await page.getByTestId('workflow-index-create').click()
    const dialog = page.getByTestId('workspace-workflow-create-mode-dialog')
    await expect(dialog).toHaveAttribute('data-context-table-id', '12')
    await page.getByTestId('workflow-create-source-table').selectOption({ label: 'Touchpoints' })
    await expect(dialog).toHaveAttribute('data-context-table-id', '13')
    await page.getByTestId('create-mode-template').click()
    await page.getByTestId('workflow-launcher-template-card').filter({ hasText: 'Email someone on every new record' }).click()

    await expect.poll(() => api.workflowPosts).toHaveLength(1)
    expect(api.workflowPosts[0]).toMatchObject({ trigger: { documentPath: DOC_PATH, tableId: '13' } })
    expect(tables.fieldsCalls[0]).toEqual({ path: DOC_PATH, tableId: '13' })
  })

  test('email inbox sync is launched from the shared template picker', async ({ page }) => {
    const { api } = await setup(page, MULTI_TABLE)
    await page.route('**/api/v1/email-sync/workflows', (route) => fulfillJson(route, { code: 200, data: { items: [] } }))
    await openTableFileWorkflowsTab(page)

    await page.getByTestId('workflow-index-create').click()
    await page.getByTestId('create-mode-template').click()
    await page.getByTestId('email-sync-workflow-template').click()

    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    // The template opens as a workflow canvas (a schedule trigger, then the
    // inbox sync); its email settings open from "Configure email".
    await expect(page.getByRole('heading', { name: 'Sync email inbox' })).toBeVisible()
    await expect(page.getByRole('button', { name: /trigger: Scheduled trigger/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /action: Sync email inbox/ })).toBeVisible()
    await expect(page.getByTestId('email-sync-workflow-editor')).toHaveCount(0)
    await page.getByRole('button', { name: 'Configure email' }).click()
    await expect(page.getByTestId('email-sync-workflow-editor')).toBeVisible()
    await expect(page.getByTestId('email-sync-table-select')).toContainText('Prospects')
    await expect(page.getByTestId('email-sync-settings-panel')).toContainText(DOC_PATH)
    expect(api.workflowPosts).toHaveLength(0)
  })

  test('the onboarding Inbox opens with the included email sync workflow', async ({ page }) => {
    const { api } = await setup(page, ONBOARDING_INBOX_TABLES, ONBOARDING_INBOX_PATH)
    await page.route('**/api/v1/email-sync/workflows', (route) => fulfillJson(route, { code: 200, data: { items: [] } }))
    await openTableFileWorkflowsTab(page, ONBOARDING_INBOX_PATH)

    await expect(page.getByTestId('email-sync-onboarding-workflow-page')).toBeVisible()
    await expect(page.getByTestId('workflow-index-empty')).toHaveCount(0)
    const trigger = page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')
    await expect(trigger).toContainText('Scheduled trigger')
    await expect(trigger).toContainText('Every 15 minutes')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Sync email inbox')

    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await expect(page.getByTestId('email-sync-workflow-editor')).toBeVisible()
    await expect(page.getByTestId('email-sync-table-select')).toContainText('Inbox')
    await expect(page.getByTestId('email-sync-settings-panel')).toContainText(ONBOARDING_INBOX_PATH)
    expect(api.workflowPosts).toHaveLength(0)
  })

  test('reopening a configured onboarding Inbox returns to its workflow canvas', async ({ page }) => {
    await page.setViewportSize({ width: 2048, height: 1152 })
    const emailWorkflow = {
      id: 'mail_onboarding',
      name: '163 Mail inbox',
      connection: { host: 'imap.163.com', port: 993, tls_mode: 'tls', username: 'person@163.com', mailbox: 'INBOX' },
      target: { table_path: ONBOARDING_INBOX_PATH, content_folder: 'Mail/Messages', attachment_folder: 'Mail/Attachments' },
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
    await setup(page, ONBOARDING_INBOX_TABLES, ONBOARDING_INBOX_PATH)
    await page.route('**/api/v1/email-sync/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/v1/email-sync/workflows') return fulfillJson(route, { code: 200, data: { items: [emailWorkflow] } })
      if (path === '/api/v1/email-sync/runs') return fulfillJson(route, { code: 200, data: { items: [completedRun] } })
      return fulfillJson(route, { code: 200, data: {} })
    })
    await openTableFileWorkflowsTab(page, ONBOARDING_INBOX_PATH)

    await expect(page.getByTestId('email-sync-workflow-page')).toBeVisible()
    await expect(page.getByTestId('email-sync-workflow-page')).toContainText('163 Mail inbox')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Scheduled trigger')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Sync email inbox')
    await expect(page.getByTestId('email-sync-workflow-row')).toHaveCount(0)
  })

  test('the onboarding workflow appears on first open, is enabled, and creates a real test row', async ({ page }) => {
    const { api } = await setup(page, STARTER_CONTENT_TABLES)
    await openTableFileWorkflowsTab(page)

    await expect.poll(() => api.workflowPosts).toHaveLength(1)
    expect(api.workflowPosts[0]).toMatchObject({
      enabled: true,
      trigger: {
        type: 'record_created',
        documentPath: DOC_PATH,
        tableId: '12',
        requiredFields: ['fld_idea', 'fld_channel', 'fld_priority', 'fld_status'],
      },
      action: {
        type: 'add_record',
        addRecord: { targetDocumentPath: DOC_PATH, targetTableId: '13' },
      },
    })

    await expect(page.getByTestId('workflow-home-page')).toBeVisible()
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]')).toContainText('Content Ideas')
    await expect(page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')).toContainText('Publishing Queue')
    await expect(page.getByTestId('status-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('workflow-add-record-test-step')).toBeVisible()
    await page.getByTestId('workflow-home-sample-row-picker').click()
    await page.getByTestId('workflow-home-sample-row-option').click()
    await expect.poll(() => api.nodeTests).toHaveLength(1)
    expect(api.nodeTests[0]).toMatchObject({
      triggerFields: { idea: 'Launch checklist', channel: 'Blog', priority: 'High', status: 'Drafting' },
    })
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Publishing Queue')
  })

  test('Task Tracker onboarding adds two workflows, persists the filter, and can run the schedule now', async ({ page }) => {
    const { tables, api } = await setup(page, STARTER_TASK_TABLES)
    await openTableFileWorkflowsTab(page)

    await expect.poll(() => tables.tableCreates).toHaveLength(1)
    expect(tables.tableCreates[0]).toMatchObject({ path: DOC_PATH, title: 'Completed Tasks', feature: 'onboarding' })
    await expect.poll(() => api.workflowPosts).toHaveLength(2)
    await expect.poll(() => api.workflowPatches).toHaveLength(1)
    expect(api.workflowPatches[0]).toMatchObject({
      enabled: true,
      nodes: expect.arrayContaining([
        expect.objectContaining({
          kind: 'filter',
          config: expect.objectContaining({ expression: 'trigger_1.Status == "Done"' }),
        }),
      ]),
    })
    expect(api.workflowPosts.map((item) => item.name)).toEqual([
      'Archive completed tasks',
      'Create a weekday planning task',
    ])
    expect(api.workflowPosts[1]).toMatchObject({
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
    await expect.poll(() => api.nodeTests).toHaveLength(1)
    expect(api.nodeTests[0]).toEqual({})
    await expect(page.getByTestId('workflow-add-record-test-status')).toBeVisible()
  })

  test('a scheduled add-record workflow keeps its target table file in the draft', async ({ page }) => {
    const { api } = await setup(page, STARTER_TASK_TABLES)
    await openTableFileWorkflowsTab(page)
    await expect.poll(() => api.workflowPosts).toHaveLength(2)
    expect(api.workflowPosts[1]).toMatchObject({ action: { addRecord: { targetDocumentPath: DOC_PATH, targetTableId: '12' } } })

    await page.getByRole('row').filter({ hasText: 'Create a weekday planning task' }).click()
    await page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]').click()
    await page.getByTestId('workflow-add-record-run-now').click()
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Tasks')
  })

  test('Reading Tracker onboarding creates a journal workflow and writes a real snapshot', async ({ page }) => {
    const { tables, api } = await setup(page, STARTER_READING_TABLES)
    await openTableFileWorkflowsTab(page)

    await expect.poll(() => tables.tableCreates).toHaveLength(1)
    expect(tables.tableCreates[0]).toMatchObject({ title: 'Reading Journal' })
    await expect.poll(() => api.workflowPosts).toHaveLength(1)
    expect(api.workflowPosts[0]).toMatchObject({
      enabled: true,
      trigger: { type: 'record_created_or_updated', documentPath: DOC_PATH, tableId: '12' },
      action: { addRecord: { targetTableId: '101' } },
    })

    await expect(page.getByTestId('workflow-home-page')).toBeVisible()
    await page.getByTestId('workflow-home-sample-row-picker').click()
    await page.getByTestId('workflow-home-sample-row-option').click()
    await expect.poll(() => api.nodeTests).toHaveLength(1)
    expect(api.nodeTests[0]).toMatchObject({
      triggerFields: { title: 'Agent workflow patterns', status: 'Reading' },
    })
    await expect(page.getByTestId('workflow-add-record-test-status')).toContainText('Reading Journal')
  })
})
