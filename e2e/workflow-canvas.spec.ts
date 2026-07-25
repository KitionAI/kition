import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { selectWorkflowMoreAction } from './helpers/workflowUi'

const VAULT_PATH = '/tmp/kition-workflow-canvas-e2e-vault'

/**
 * Canvas+Drawer+StatusBanner e2e (M4 surface).
 *
 * Targets §11.1 A4 (StatusBanner four states), A5 (node-level error + Fix),
 * A6 (Properties Drawer), A8 (Run history jump-to-node).
 *
 * Each test mocks /v1/workflows to seed exactly one workflow in the home
 * list — fixed shape so the assertions stay readable. The actual save /
 * connection / run-history endpoints are mocked per-test to avoid hitting
 * the real backend during CI.
 */
async function mockSuppressLauncher(page: Page) {
  await page.addInitScript(({ vaultPath }) => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const vault = {
      path: vaultPath,
      name: 'Workflow Canvas E2E Vault',
      added_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    }
    const registry = () => ({ vaults: [vault], active_vault_path: vaultPath })
    const listResponse = () => ({ root_path: vaultPath, items: [] })
    stateWindow.kitionDesktop = {
      shell: 'electron',
      DesktopInfo: async () => ({
        is_desktop: false,
        platform: 'darwin',
        backend_base_url: '',
        data_dir: '',
        cache_dir: '',
        logs_dir: '',
        uploads_dir: '',
        exports_dir: '',
        workspace_dir: vaultPath,
        supports_secure_storage: false,
      }),
      StoreSecureValue: async () => {},
      ReadSecureValue: async (key: string) => {
        if (key === 'kition.desktop.settings.v1') {
          return JSON.stringify({
            models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-4o' } },
            providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: '', apiKey: '', discoveredModels: ['gpt-4o'] } },
          })
        }
        if (key === 'desktop.provider.openai.apiKey.v1') return 'sk-stub'
        return ''
      },
      DeleteSecureValue: async () => {},
      OpenExternalURL: async () => {},
      ListVaults: async () => registry(),
      AddVault: async () => ({ vault, registry: registry() }),
      RemoveVault: async () => registry(),
      RenameVault: async () => ({ vault, registry: registry() }),
      SetActiveVault: async () => ({ list: listResponse(), registry: registry() }),
      ListWorkspaceDocuments: async () => listResponse(),
      ReadWorkspaceDocument: async () => { throw new Error('not used') },
      WriteWorkspaceDocument: async () => { throw new Error('not used') },
    }
  }, { vaultPath: VAULT_PATH })
}

interface SeedOptions {
  enabled: boolean
  to: string
  subject: string
  connectionId: string
  /** When set, /runs returns one error run with this message + failingNodeId. */
  failingMessage?: string
  failingNodeId?: string
  /** When set, /connections returns a single email_smtp connection with this status. */
  connectionStatus?: 'active' | 'invalid' | 'pending'
  connectionError?: string
}

async function seedWorkflow(page: Page, opts: SeedOptions) {
  const workflow = {
    id: 'auto_canvas',
    name: 'New lead email notification',
    description: '',
    enabled: opts.enabled,
    schemaVer: 2,
    trigger: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' },
    action: {
      nodeId: 'action_1',
      type: 'send_email',
      connectionId: opts.connectionId,
      to: opts.to,
      subject: opts.subject,
      body: { parts: [{ kind: 'text', text: 'Hi team' }] },
    },
    nodes: [
      { nodeId: 'trigger_1', kind: 'trigger', config: { nodeId: 'trigger_1', type: 'record_created', tableId: 'tbl_leads' } },
      { nodeId: 'action_1', kind: 'action', config: { nodeId: 'action_1', type: 'send_email', to: opts.to, subject: opts.subject } },
    ],
    edges: [{ from: 'trigger_1', to: 'action_1' }],
  }
  await page.route('**/v1/workflows', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [workflow] }) })
  })
  await page.route('**/v1/workflows/auto_canvas', (route: Route) => {
    if (route.request().method() === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}')
      const next = { ...workflow, ...body, action: { ...workflow.action, ...(body.action || {}) } }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, workflow: next }) })
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workflow) })
  })
  await page.route('**/v1/workflows/auto_canvas/runs?limit=1', (route: Route) => {
    if (!opts.failingMessage) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
    }
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ runs: [{
        id: 'run_err', workflowId: 'auto_canvas', triggerEvent: 'record.created', recordId: 'rec_1',
        startedAt: '2026-06-13T10:00:00Z', finishedAt: '2026-06-13T10:00:01Z', status: 'error',
        to: opts.to, subject: opts.subject, body: 'Hi',
        error: opts.failingMessage, failingNodeId: opts.failingNodeId || 'action_1',
      }] }),
    })
  })
  await page.route('**/v1/workflows/auto_canvas/runs?limit=50', (route: Route) => {
    if (!opts.failingMessage) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
    }
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ runs: [{
        id: 'run_err', workflowId: 'auto_canvas', triggerEvent: 'record.created', recordId: 'rec_1',
        startedAt: '2026-06-13T10:00:00Z', finishedAt: '2026-06-13T10:00:01Z', status: 'error',
        to: opts.to, subject: opts.subject, body: 'Hi',
        error: opts.failingMessage, failingNodeId: opts.failingNodeId || 'action_1',
      }] }),
    })
  })
  await page.route('**/v1/channels', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
      channel: 'email_smtp', label: 'Email (SMTP)', icon: '✉', description: 'd', auth: 'password', fields: [],
    }]) })
  })
  await page.route('**/v1/connections', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: opts.connectionId ? [{
      id: opts.connectionId, channel: 'email_smtp', name: 'Legacy SMTP config',
      settings: { host: 'smtp.example.com', port: 587, username: 'u', tlsMode: 'starttls', from: 'noreply@example.com', fromName: '' },
      status: opts.connectionStatus || 'active',
      lastErrorMessage: opts.connectionError || '',
      usedByCount: 1,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }] : [] }) })
  })
  await page.route('**/v1/data-documents/*/tables/*/fields', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: '', data: { items: [], total: 0 } }) })
  })
  await page.route('**/v1/data-documents', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'doc_1', title: 'Leads workspace', tables: [{ id: 'tbl_leads', title: 'Leads', name: 'leads' }] }] }) })
  })
}

async function gotoHome(page: Page) {
  await page.goto('/workflow/auto_canvas')
}

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
})

test('A4 StatusBanner — failing state when last run errored shows Fix CTA', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
    connectionStatus: 'invalid',
    connectionError: 'smtp host not configured',
    failingMessage: 'smtp host not configured',
    failingNodeId: 'action_1',
  })
  await gotoHome(page)
  await expect(page.getByTestId('workflow-home-page')).toBeVisible()
  const banner = page.getByTestId('workflow-status-banner')
  await expect(banner).toHaveAttribute('data-banner-state', 'failing')
  await expect(banner).toContainText('smtp host not configured')
  await expect(page.getByTestId('workflow-status-banner-fix')).toBeVisible()
})

test('A4 StatusBanner — configured_disabled state shows Enable now CTA', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: false,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  await gotoHome(page)
  const banner = page.getByTestId('workflow-status-banner')
  await expect(banner).toHaveAttribute('data-banner-state', 'configured_disabled')
  await expect(page.getByTestId('workflow-status-banner-enable')).toBeVisible()
})

test('A4 StatusBanner — enabled + healthy hides banner', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  await gotoHome(page)
  // Wait for page to mount, then verify banner state.
  await expect(page.getByTestId('workflow-home-page')).toBeVisible()
  await expect(page.getByTestId('workflow-status-banner')).toHaveAttribute('data-banner-state', 'enabled')
})

test('A5 Node-level inline error renders Fix button on the failing action node', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
    connectionStatus: 'invalid',
    connectionError: 'smtp host not configured',
    failingMessage: 'smtp host not configured',
    failingNodeId: 'action_1',
  })
  await gotoHome(page)
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await expect(actionNode).toBeVisible()
  await expect(actionNode.locator('[data-testid="workflow-node-error"]')).toContainText('smtp host not configured')
  await expect(actionNode.locator('[data-testid="workflow-node-fix"]')).toBeVisible()
})

test('A6 Properties Drawer switches content when the trigger node is selected', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  await gotoHome(page)
  // Drawer defaults to Action panel.
  const drawer = page.getByTestId('workflow-properties-drawer')
  await expect(drawer).toHaveAttribute('data-state', 'open')
  await expect(drawer).toContainText('Send email')
  // Click trigger node → drawer flips to Trigger panel.
  await page.locator('[data-testid="workflow-canvas-node"][data-node-role="trigger"]').click()
  await expect(drawer).toContainText('When a record is created')
})

test('A8 Run history failing-node link jumps back to Edit workflow with node selected', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
    failingMessage: 'smtp host not configured',
    failingNodeId: 'action_1',
  })
  await gotoHome(page)
  await selectWorkflowMoreAction(page, 'workflow-home-history')
  const row = page.getByTestId('run-row-0').first()
  await expect(row).toBeVisible()
  await row.locator('[data-testid="run-history-jump-to-node"]').click()
  // Jump returns to configuration tab.
  await expect(page.getByTestId('workflow-home-configuration-tab')).toBeVisible()
  // Action node is the selected one (drawer shows Send email).
  await expect(page.getByTestId('workflow-properties-drawer')).toContainText('Send email')
})

test('A10 Ask AI on the action node dispatches kition:workflow-node:ask-ai with node context', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  await gotoHome(page)
  // Install an in-page listener that records the next event and exposes it
  // to playwright via a window-level promise. We bind BEFORE the click so
  // the dispatch never escapes.
  await page.evaluate(() => {
    const win = window as typeof window & { __askAIEvent?: unknown }
    return new Promise<void>((resolve) => {
      win.__askAIEvent = null
      const handler = (event: Event) => {
        win.__askAIEvent = (event as CustomEvent).detail
        window.removeEventListener('kition:workflow-node:ask-ai', handler)
        resolve()
      }
      window.addEventListener('kition:workflow-node:ask-ai', handler)
      // Promise gets resolved in the handler; the outer evaluate just
      // returns once the binding is in place so the click can happen.
      setTimeout(() => resolve(), 0)
    })
  })
  // Hover surfaces the pill; click forwards through stopPropagation.
  const actionNode = page.locator('[data-testid="workflow-canvas-node"][data-node-role="action"]')
  await actionNode.hover()
  await actionNode.locator('[data-testid="workflow-node-ask-ai"]').click({ force: true })
  const detail = await page.evaluate(() => (window as typeof window & { __askAIEvent?: any }).__askAIEvent)
  expect(detail).toBeTruthy()
  expect(detail.workflow.id).toBe('auto_canvas')
  expect(detail.nodeKind).toBe('action')
  expect(detail.nodeId).toBe('action_1')
  expect(detail.nodeConfig).toMatchObject({ to: 'sevennt.leslie@gmail.com', subject: 'New Lead' })
})

test('A12 Connection inline Edit on the action node Fix CTA opens the modal pre-populated with the current connection', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: false,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
    connectionStatus: 'invalid',
    connectionError: 'smtp host not configured',
  })
  await gotoHome(page)
  // Action panel renders the chip when a connection is selected. Click it.
  await expect(page.getByTestId('workflow-properties-drawer')).toBeVisible()
  await page.getByTestId('workflow-home-edit-connection').click()
  // ConnectionModal mounts on top, pre-filled with the selected connection.
  await expect(page.getByTestId('connection-name')).toHaveValue('Legacy SMTP config')
  await expect(page.getByTestId('connection-host')).toHaveValue('smtp.example.com')
  await expect(page.getByTestId('connection-from')).toHaveValue('noreply@example.com')
})

test('A7 Drawer Test step calls /nodes/:nodeId/test and shows the delivered-to banner', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: true,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  // Mock the per-node test endpoint.
  let nodeTestHit = false
  await page.route('**/v1/workflows/auto_canvas/nodes/action_1/test', async (route) => {
    nodeTestHit = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        input: { to: 'sevennt.leslie@gmail.com', subject: '[TEST] New Lead', body: 'Hi team' },
      }),
    })
  })
  await gotoHome(page)
  // Drawer defaults to Action panel. Click Run with sample.
  const runButton = page.getByTestId('workflow-drawer-run-with-sample')
  await expect(runButton).toBeVisible()
  await runButton.click()
  await expect(page.getByTestId('workflow-drawer-test-step-status')).toContainText('Test delivered to sevennt.leslie@gmail.com')
  expect(nodeTestHit).toBe(true)
})

test('A9 InsertPoint popover offers Add action / Add filter when "+" is clicked', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: false,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  await gotoHome(page)
  // Slot #1 sits between trigger and action.
  const insertButton = page.getByTestId('workflow-insert-1-button')
  await expect(insertButton).toBeVisible()
  await insertButton.click()
  const menu = page.getByTestId('workflow-insert-1-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('workflow-insert-1-add-action')).toBeVisible()
  await expect(menu.getByTestId('workflow-insert-1-add-filter')).toBeVisible()
  // Pressing Escape closes the menu without dispatching.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('A1 DocTab — /workflow URL opens a doc tab (no modal overlay)', async ({ page }) => {
  await seedWorkflow(page, {
    enabled: false,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: 'conn_a',
  })
  // Land on /documents (the regular workspace shell), then push the
  // /workflow URL to mount the global workflow list as a doc tab.
  await page.goto('/documents')
  await page.evaluate(() => {
    const state = { ...(window.history.state || {}) }
    delete (state as Record<string, unknown>).workflowContext
    delete (state as Record<string, unknown>).selectedWorkflowId
    window.history.pushState(state, '', '/workflow')
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  })
  // New flow: an workflow doc tab mounts. data-workflow-tab="true"
  // is the new attribute on the tab wrapper; data-testid stays
  // workspace-workflow-workbench so the legacy real-API suite's
  // assertions continue to hold.
  // The global list and kitable-scoped list share the same DocTab detail
  // transition. Clicking a row must update this workbench's workflowId;
  // it must not open the legacy full-screen /workflow/{id} surface.
  await expect(page.getByTestId('workspace-workflow-workbench')).toBeVisible()
  await expect(page.getByTestId('workflow-index-page')).toBeVisible()
  await page.locator('[data-testid="workflow-index-row"][data-workflow-id="auto_seed"]').click()
  await expect(page.getByTestId('workflow-home-page')).toBeVisible()
  await expect(page.getByTestId('workspace-workflow-workbench')).toHaveCount(1)
  await expect(page.getByTestId('workflow-route-overlay')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => window.location.pathname)).toBe('/workflow')
})

test('AskAI configure_smtp_connection → dropdown refreshes with the new connection', async ({ page }) => {
  // Seed with no connection so the new SMTP one is unambiguous in the dropdown.
  await seedWorkflow(page, {
    enabled: false,
    to: 'sevennt.leslie@gmail.com',
    subject: 'New Lead',
    connectionId: '',
  })
  // Override /v1/connections to flip after a synthetic "configured" signal:
  // the first call returns empty (initial mount), subsequent calls return
  // the AI-created row. The page should refresh once it gets the
  // kition:connections:changed broadcast.
  let refreshed = false
  await page.route('**/v1/connections', (route) => {
    const body = refreshed
      ? {
          items: [{
            id: 'conn_smtp_ai',
            channel: 'email_smtp',
            name: 'Gmail SMTP (Ask AI)',
            settings: { host: 'smtp.gmail.com', port: 587, username: 'sevennt.leslie@gmail.com', tlsMode: 'starttls', from: 'sevennt.leslie@gmail.com', fromName: 'Kition Test' },
            status: 'active',
            lastErrorMessage: '',
            usedByCount: 0,
            createdAt: '2026-06-13T03:00:00Z', updatedAt: '2026-06-13T03:00:00Z',
          }],
        }
      : { items: [] }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await gotoHome(page)
  // Drawer opens to Action panel; dropdown initially shows the fallback only.
  const connectionSelect = page.getByTestId('workflow-home-connection')
  await expect(connectionSelect).toBeVisible()
  await expect(connectionSelect.locator('option')).toHaveCount(1)

  // Simulate the agent panel completing a configure_smtp_connection tool
  // call. The broadcast is what useWorkspaceAgent dispatches when it sees
  // the SSE event; in real flow this fires after the model calls the
  // tool and the backend returns the new row.
  refreshed = true
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('kition:connections:changed', { detail: { source: 'configure_smtp_connection' } }))
  })

  // The page refreshes /v1/connections and the new row appears in the dropdown.
  await expect(connectionSelect.locator('option')).toHaveCount(2)
  await expect(connectionSelect).toContainText('Gmail SMTP (Ask AI)')
})
