import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-workflow-e2e-vault'

/**
 * Mirror of mockSuppressLauncher from scenario.spec.ts — injects a kitionDesktop
 * shim with an active vault so Shell.tsx does NOT pop the WorkspaceLauncher
 * fullscreen overlay (z-40) that sits above the workflow route (z-30).
 */
async function mockSuppressLauncher(page: Page) {
  await page.addInitScript(({ vaultPath }) => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const vault = {
      path: vaultPath,
      name: 'Workflow E2E Vault',
      added_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    }
    function makeRegistry() {
      return { vaults: [vault], active_vault_path: vaultPath }
    }
    function makeListResponse() {
      return { root_path: vaultPath, items: [] }
    }
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
        if (key === 'desktop.provider.openai.apiKey.v1') {
          return 'sk-stub'
        }
        return ''
      },
      DeleteSecureValue: async () => {},
      OpenExternalURL: async () => {},
      ListVaults: async () => makeRegistry(),
      AddVault: async () => ({ vault, registry: makeRegistry() }),
      RemoveVault: async () => makeRegistry(),
      RenameVault: async () => ({ vault, registry: makeRegistry() }),
      SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),
      ListWorkspaceDocuments: async () => makeListResponse(),
      ReadWorkspaceDocument: async () => {
        throw new Error('not used in workflow e2e')
      },
      WriteWorkspaceDocument: async () => {
        throw new Error('not used in workflow e2e')
      },
    }
  }, { vaultPath: VAULT_PATH })
}

async function mockWorkflowBuild(page: Page) {
  await page.route('**/v1/workflows/build', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    if (!body.model?.provider_type || !body.model?.model_name) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'model not configured' }) })
    }
    const frames = [
      { kind: 'workflow.generated', workflowId: 'auto_test', name: 'Form Submission Email Notification to Sales', description: 'd' },
      { kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl_leads', config: { tableId: 'tbl_leads' } },
      { kind: 'action.generated', nodeId: 'n2', actionType: 'send_email', config: { to: 'sales@x.com', subject: 'New Lead Submission Notification', body: { parts: [{ kind: 'text', text: 'Hi ' }, { kind: 'field_ref', fieldRef: { nodeId: 'n1', fieldId: 'fld_first' } }] } } },
      { kind: 'workflow.created', workflowId: 'auto_test' },
      { kind: 'done' },
    ]
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
    })
  })
}

async function mockSchema(page: Page) {
  // Backend's documentId-scoped fields endpoint, wrapped in the standard
  // {code, message, data: {items, total}} envelope from core.Response.
  await page.route('**/v1/data-documents/*/tables/*/fields', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        message: '',
        data: {
          items: [{ id: 'fld_first', name: 'first_name', title: 'First Name', type: 'text' }],
          total: 1,
        },
      }),
    })
  })
}

/**
 * Mocks the workflow read APIs the home page hits after the AI surface hands
 * off to it: list workflows, fetch the latest run per workflow id, and the
 * draft validator. Returns just the freshly-built auto_test workflow so the
 * home page selects it via initialSelectedId.
 */
async function mockWorkflowsHomeReads(page: Page) {
  await page.route('**/v1/workflows', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          id: 'auto_test',
          name: 'Form Submission Email Notification to Sales',
          description: 'd',
          enabled: false,
          trigger: { nodeId: 'n1', type: 'record_created', tableId: 'tbl_leads', documentId: '1' },
          action: {
            nodeId: 'n2',
            type: 'send_email',
            connectionId: '',
            to: 'sales@x.com',
            subject: { parts: [{ kind: 'text', text: 'New Lead Submission Notification' }] },
            body: { parts: [{ kind: 'text', text: 'Hi ' }, { kind: 'field_ref', fieldRef: { nodeId: 'n1', fieldId: 'fld_first' } }] },
          },
          nodes: [
            { nodeId: 'n1', kind: 'trigger', config: { type: 'record_created', tableId: 'tbl_leads' } },
            { nodeId: 'n2', kind: 'action', config: { type: 'send_email' } },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        }],
      }),
    })
  })
  await page.route('**/v1/workflows/auto_test/runs?limit=1', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) })
  })
  await page.route('**/v1/workflows/auto_test/validate', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ issues: [] }) })
  })
  await page.route('**/v1/connections', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
  await page.route('**/v1/channels', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
}

/**
 * Shell.tsx only mounts WorkflowRoute when history.state carries an
 * workflowContext (documentId + tableId + tableName). In production the
 * WorkspaceScreen Automate topbar button pushes this state before navigating;
 * in tests we inject it directly.
 */
async function gotoWorkflowNew(page: Page) {
  await page.addInitScript(() => {
    if (window.location.pathname.startsWith('/workflow')) {
      window.history.replaceState(
        { workflowContext: { documentId: '1', tableId: '7', tableName: 'Leads' } },
        '',
        window.location.pathname,
      )
    }
  })
  await page.goto('/workflow/new')
}

test.beforeEach(async ({ page }) => {
  await mockSuppressLauncher(page)
  await mockLocalWorkspaceApi(page)
  await mockSchema(page)
})

test('AI build inlines a streaming row inside WorkflowHomePage and swaps it to the real workflow on workflow.created', async ({ page }) => {
  await mockWorkflowBuild(page)
  await mockWorkflowsHomeReads(page)
  await gotoWorkflowNew(page)
  await expect(page.getByTestId('workflow-new-page')).toBeVisible()
  await page.getByTestId('workflow-launcher-cta-ai').click()
  await page.getByTestId('workflow-prompt').fill('create an workflow: email sales@x.com when visitors submit.')
  await page.getByTestId('workflow-launcher-ai-submit').click()

  // workflow.created fires fast in this mock — WorkflowRoute resets build
  // state, replaces URL to /workflow, and the index page renders with the
  // freshly persisted row. The detail editor lives at /workflow/{id} now;
  // we assert the post-completion landing here.
  await expect.poll(async () => page.evaluate(() => (window.history.state as { selectedWorkflowId?: string } | null)?.selectedWorkflowId)).toBe('auto_test')
  await expect.poll(async () => page.evaluate(() => window.location.pathname)).toBe('/workflow')
  await expect(page.getByTestId('workflow-index-page')).toBeVisible()
  await expect(page.locator('[data-testid="workflow-index-row"][data-workflow-id="auto_test"]')).toBeVisible()
})

test('AI build streaming banner stays visible (no handoff) when the build endpoint emits an error event', async ({ page }) => {
  await page.route('**/v1/workflows/build', (route) => {
    const frames = [
      { kind: 'workflow.generated', workflowId: 'auto_test', name: 'Partial workflow', description: 'd' },
      { kind: 'error', code: 'model_failed', message: 'LLM output not JSON' },
      { kind: 'done' },
    ]
    route.fulfill({
      status: 200, headers: { 'content-type': 'text/event-stream' },
      body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
    })
  })
  // Provide a list mock even for the error path so the home page mounts;
  // the streaming row + error banner are what's under test.
  await page.route('**/v1/workflows', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
  await gotoWorkflowNew(page)
  await page.getByTestId('workflow-launcher-cta-ai').click()
  await page.getByTestId('workflow-prompt').fill('p')
  await page.getByTestId('workflow-launcher-ai-submit').click()
  // Streaming-error banner renders; the synthetic row is still in the list.
  await expect(page.getByTestId('workflow-home-streaming-error')).toContainText('LLM output not JSON')
  // workflow.created never fired → URL is not rewritten.
  await expect.poll(async () => page.evaluate(() => window.location.pathname)).toBe('/workflow/new')
})

test('sends the configured model on the build request', async ({ page }) => {
  let capturedBody: Record<string, unknown> | null = null
  await page.route('**/v1/workflows/build', async (route) => {
    capturedBody = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        { kind: 'workflow.generated', workflowId: 'auto_test', name: 'X', description: 'd' },
        { kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl_leads', config: { tableId: 'tbl_leads' } },
        { kind: 'action.generated', nodeId: 'n2', actionType: 'send_email', config: { to: 'x@y', subject: 's', body: { parts: [] } } },
        { kind: 'workflow.created', workflowId: 'auto_test' },
        { kind: 'done' },
      ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
    })
  })
  await mockWorkflowsHomeReads(page)
  await gotoWorkflowNew(page)
  await page.getByTestId('workflow-launcher-cta-ai').click()
  await page.getByTestId('workflow-prompt').fill('p')
  await page.getByTestId('workflow-launcher-ai-submit').click()
  // Wait for completion landing — index page renders the persisted row
  // once workflow.created arrives and WorkflowRoute resets build state.
  // This proves the build request fired (capturedBody is populated) AND
  // the route hand-off chain completed.
  await expect(page.getByTestId('workflow-index-page')).toBeVisible()
  const model = (capturedBody as Record<string, unknown> | null)?.model as Record<string, unknown> | undefined
  expect(model?.provider_type).toBe('openai')
  expect(model?.model_name).toBe('gpt-4o')
  expect(model?.api_key).toBe('sk-stub')
})
