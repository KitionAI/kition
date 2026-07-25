import { expect, test, type Page, type Route } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-scenario-e2e-vault'

/**
 * Provide a desktop bridge mock with an active vault so Shell.tsx does NOT
 * pop the WorkspaceLauncher fullscreen overlay (z-40, sits above /scenario
 * route z-30). Without this, browser-mode tests can interact with the
 * /scenario landing UI for assertions that don't need clicks (Test A) but
 * clicks past that point get intercepted by the launcher. We also leave
 * `is_desktop: false` so resolveApiURL keeps pointing at /api/v1/* —
 * mockLocalWorkspaceApi listens on that prefix.
 */
async function mockSuppressLauncher(page: Page) {
  await page.addInitScript(({ vaultPath }) => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const vault = {
      path: vaultPath,
      name: 'Scenario E2E Vault',
      added_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    }
    function makeRegistry() {
      return { vaults: [vault], active_vault_path: vaultPath }
    }
    function makeListResponse() {
      return {
        root_path: vaultPath,
        items: [],
      }
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
      ReadSecureValue: async () => '',
      DeleteSecureValue: async () => {},
      OpenExternalURL: async () => {},
      ListVaults: async () => makeRegistry(),
      AddVault: async () => ({ vault, registry: makeRegistry() }),
      RemoveVault: async () => makeRegistry(),
      RenameVault: async () => ({ vault, registry: makeRegistry() }),
      SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),
      ListWorkspaceDocuments: async () => makeListResponse(),
      ReadWorkspaceDocument: async () => {
        throw new Error('not used in scenario e2e')
      },
      WriteWorkspaceDocument: async () => {
        throw new Error('not used in scenario e2e')
      },
    }
  }, { vaultPath: VAULT_PATH })
}

   
                                                                 
  
      
                                                       
                                      
                                                             
                                                                    
                                       
                                                                        
             
  
                       
                                                             
                                                
                                                      
                                    
                                                                  
                      
  
        
                                                                  
                                                                    
                                                                  
                                          
                                                                
               
                                                                  
                                                               
   

const FAKE_PNG = Buffer.from([
  // Minimal 1x1 PNG header — enough for the browser to accept the upload.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/**
 * Build a happy-path SSE body covering all 4 progress rows + cell fill +
 * terminal `done` frame. route.fulfill ships the whole body at once but the
 * frontend SSE parser splits on `\n\n` so the reducer ends up running through
 * every event.
 */
function buildHappyPathSseBody(): string {
  const events = [
    { kind: 'base.created', baseId: 'b1', baseName: 'Test Base' },
    { kind: 'table.created', tableId: 't1', tableName: 'Receipts' },
    { kind: 'fields.generated', stage: 'fields', count: 2 },
    { kind: 'fields.generated', stage: 'ai-fields', count: 3 },
    { kind: 'records.generated', count: 1 },
    { kind: 'views.generated', viewKind: 'grid', viewId: 'v1', viewName: 'Overall' },
    { kind: 'cell.ai.filled', recordId: 1, fieldId: 3, value: 'STRONG FLOUR' },
    { kind: 'done' },
  ]
  return events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('')
}

async function mockScenarioBuildSse(page: Page, sseBody: string) {
  await page.route('**/scenarios/build', async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: sseBody,
    })
  })
}

/**
 * The /scenario build page mounts TableEditor once `base.created` +
 * `table.created` land, and TableEditor reaches out to /api/v1/data-documents
 * to resolve the marker. Tests only care about the build view layout flipping —
 * we just need the request to not 500 and not hang. Return a minimal but valid
 * document payload so the editor doesn't bail loudly. Route is registered
 * before the test that needs it so the table mount doesn't blow up the suite.
 */
async function mockMinimalDataDocumentApi(page: Page) {
  await page.route('**/api/v1/data-documents/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/open — resolve the marker payload to a document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: minimalDocumentFixture(),
        }),
      })
    }
    // GET /data-documents/1 — full document
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: minimalDocumentFixture(),
        }),
      })
    }
    // GET /data-documents/1/tables/11/records — empty rows are fine
    if (method === 'GET' && /\/tables\/\d+\/records$/.test(path)) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: { items: [], total: 0, offset: 0, limit: 200 },
        }),
      })
    }
    // Catch-all empty success for PATCH view / etc.
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 200, data: {} }),
    })
  })
}

function minimalDocumentFixture() {
  return {
    id: 1,
    user_id: 1,
    workspace_root: '/tmp/kition-scenario-vault',
    path: 'scenario:1',
    title: 'Test Base',
    description: '',
    icon: '',
    color: '',
    meta: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    tables: [
      {
        id: 11,
        user_id: 1,
        document_id: 1,
        name: 'receipts',
        title: 'Receipts',
        description: '',
        order: 0,
        primary_field_id: 101,
        meta: null,
        fields: [
          {
            id: 101,
            user_id: 1,
            document_id: 1,
            table_id: 11,
            name: 'title',
            title: 'Title',
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
        ],
        views: [
          {
            id: 201,
            user_id: 1,
            document_id: 1,
            table_id: 11,
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
      },
    ],
  }
}

test.describe('scenario — talk-to-process-files happy path', () => {
  test.beforeEach(async ({ page }) => {
    await mockSuppressLauncher(page)
    await mockLocalWorkspaceApi(page)
  })

  test('Start it disabled when empty, enabled with attachments', async ({
    page,
  }) => {
    await page.goto('/scenario')

    await expect(page.getByTestId('scenario-heading')).toBeVisible()

    const startButton = page.getByTestId('scenario-start-button')
    await expect(startButton).toBeVisible()
    await expect(startButton).toBeDisabled()

    // Drop a fake PNG into the hidden file input — bypasses OS picker.
    await page.getByTestId('scenario-file-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: FAKE_PNG,
    })

    await expect(startButton).toBeEnabled()
    await expect(page.getByTestId('scenario-chip')).toHaveCount(1)
  })

  test('chip × removes the attachment', async ({ page }) => {
    await page.goto('/scenario')
    await expect(page.getByTestId('scenario-heading')).toBeVisible()

    await page.getByTestId('scenario-file-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: FAKE_PNG,
    })

    await expect(page.getByTestId('scenario-chip')).toHaveCount(1)

    await page.getByTestId('scenario-chip-remove').click()
    await expect(page.getByTestId('scenario-chip')).toHaveCount(0)

    // With no content, Start it is disabled again.
    await expect(page.getByTestId('scenario-start-button')).toBeDisabled()
  })

  test('attach + prompt + Start it → build view + 100% progress', async ({
    page,
  }) => {
    await mockScenarioBuildSse(page, buildHappyPathSseBody())
    await mockMinimalDataDocumentApi(page)

    await page.goto('/scenario')
    await expect(page.getByTestId('scenario-heading')).toBeVisible()

    await page.getByTestId('scenario-file-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: FAKE_PNG,
    })
    await page.getByTestId('scenario-prompt-input').fill('process these receipts')

    await page.getByTestId('scenario-start-button').click()

    // Build view rendered — start page gone, build shell up.
    await expect(page.getByTestId('scenario-build-page')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('scenario-heading')).toHaveCount(0)
    await expect(page.getByTestId('right-drawer')).toBeVisible()

    // All 4 progress rows reached "done" — terminal state for the build.
    for (const index of [0, 1, 2, 3]) {
      await expect(page.getByTestId(`progress-row-${index}`)).toHaveAttribute(
        'data-status',
        'done',
      )
    }
    await expect(page.getByTestId('progress-percent')).toHaveText('100%')

    // Header spinner disappears once nothing is "running" anymore.
    await expect(page.getByTestId('progress-card-header-spinner')).toHaveCount(0)
  })

  test('Back from build view returns to ScenarioStartPage', async ({
    page,
  }) => {
    await mockScenarioBuildSse(page, buildHappyPathSseBody())
    await mockMinimalDataDocumentApi(page)

    await page.goto('/scenario')

    await page.getByTestId('scenario-file-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: FAKE_PNG,
    })
    await page.getByTestId('scenario-prompt-input').fill('process these receipts')
    await page.getByTestId('scenario-start-button').click()

    await expect(page.getByTestId('scenario-build-page')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('progress-percent')).toHaveText('100%')

    // Back → useScenarioBuild.reset() + Shell.closeScenarioRoute() — note that
    // the Shell rewrites the URL away from /scenario, but the ScenarioRoute
    // itself unmounts and the start page is no longer in the DOM. Asserting
    // both ensures we exercised the full reset path.
    await page.getByTestId('scenario-build-leave').click()

    await expect(page.getByTestId('scenario-build-page')).toHaveCount(0)
    await expect(page).not.toHaveURL(/\/scenario$/)
  })

  test('Close drawer hides it and exposes Show chat re-open affordance', async ({
    page,
  }) => {
    await mockScenarioBuildSse(page, buildHappyPathSseBody())
    await mockMinimalDataDocumentApi(page)

    await page.goto('/scenario')

    await page.getByTestId('scenario-file-input').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: FAKE_PNG,
    })
    await page.getByTestId('scenario-prompt-input').fill('process these receipts')
    await page.getByTestId('scenario-start-button').click()

    await expect(page.getByTestId('scenario-build-page')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('right-drawer')).toBeVisible()
    // Show chat should NOT exist while the drawer is open.
    await expect(page.getByTestId('scenario-build-show-chat')).toHaveCount(0)

    // Close the drawer via its × button.
    await page.getByTestId('right-drawer-close').click()

    // Drawer must fully unmount (not just visually hidden).
    await expect(page.getByTestId('right-drawer')).toHaveCount(0)

    // The central area must reveal the Show chat re-open button.
    await expect(page.getByTestId('scenario-build-show-chat')).toBeVisible()

    // Central area must reclaim the freed horizontal space — the right edge
    // of the central main element should now sit at the viewport's right
    // edge (within a small tolerance for scrollbars).
    const central = await page.getByTestId('scenario-build-central').boundingBox()
    const viewportSize = page.viewportSize()
    expect(central, 'central main should have a bounding box').not.toBeNull()
    expect(viewportSize, 'viewport size should be available').not.toBeNull()
    if (central && viewportSize) {
      expect(central.x + central.width).toBeGreaterThan(viewportSize.width - 24)
    }

    // Clicking Show chat re-mounts the drawer.
    await page.getByTestId('scenario-build-show-chat').click()
    await expect(page.getByTestId('right-drawer')).toBeVisible()
    await expect(page.getByTestId('scenario-build-show-chat')).toHaveCount(0)
  })
})
