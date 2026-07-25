import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * E2E — kitable tree expansion + per-table tabs.
 *
 * Verifies:
 *  1. Clicking a .kitable row in the sidebar tree EXPANDS it (does not open a tab).
 *  2. Three table virtual-children and the Workflows leaf are visible after expansion.
 *  3. Clicking a table child row opens a tab titled with that table's name.
 *  4. Two table tabs can be open simultaneously.
 *  5. Renaming the kitable via "More actions → Rename" updates the sidebar row; both
 *     tabs remain open (they hold their title even if the underlying path is stale
 *     until the next remap cycle).
 *
 * Pattern: inline desktop-bridge mock + inline data-document API mock, following
 * the same structure as e2e/kitable.spec.ts.  No helpers that don't exist.
 */

const VAULT_PATH = '/tmp/kition-kitable-tree-e2e-vault'
const DOC_PATH = 'Leads.kitable'
const RENAMED_PATH = 'Customers.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

// ─── Fixture: data document with 3 tables ──────────────────────────────────

const FIXTURE_DOCUMENT = {
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
      id: 12,
      user_id: 1,
      document_id: 1,
      name: 'prospects',
      title: 'Prospects',
      description: '',
      order: 0,
      primary_field_id: 201,
      meta: null,
      fields: [
        {
          id: 201,
          user_id: 1,
          document_id: 1,
          table_id: 12,
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
      ],
      views: [
        {
          id: 301,
          user_id: 1,
          document_id: 1,
          table_id: 12,
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
    {
      id: 13,
      user_id: 1,
      document_id: 1,
      name: 'touchpoints',
      title: 'Touchpoints',
      description: '',
      order: 1,
      primary_field_id: 202,
      meta: null,
      fields: [
        {
          id: 202,
          user_id: 1,
          document_id: 1,
          table_id: 13,
          name: 'event',
          title: 'Event',
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
          id: 302,
          user_id: 1,
          document_id: 1,
          table_id: 13,
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
    {
      id: 14,
      user_id: 1,
      document_id: 1,
      name: 'accounts',
      title: 'Accounts',
      description: '',
      order: 2,
      primary_field_id: 203,
      meta: null,
      fields: [
        {
          id: 203,
          user_id: 1,
          document_id: 1,
          table_id: 14,
          name: 'company',
          title: 'Company',
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
          id: 303,
          user_id: 1,
          document_id: 1,
          table_id: 14,
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

const EMPTY_RECORDS = { items: [], total: 0, offset: 0, limit: 200 }

function buildWorkflow(id: string, name: string, enabled: boolean, tableId: string) {
  return {
    id,
    user_id: 1,
    name,
    description: '',
    enabled,
    trigger: {
      nodeId: `trigger_${id}`,
      type: 'record_created',
      documentId: '1',
      tableId,
    },
    action: {
      nodeId: `action_${id}`,
      type: 'send_email',
      connectionId: '',
      to: 'owner@example.com',
      subject: { parts: [{ kind: 'text', text: 'New record' }] },
      body: { parts: [{ kind: 'text', text: 'A record was created.' }] },
    },
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  }
}

async function mockKitableWorkflowApi(page: Page) {
  const workflows = [
    buildWorkflow('auto_leads', 'Lead routing', true, '12'),
    buildWorkflow('auto_followup', 'Follow-up', false, '13'),
  ]

  await page.route('**/api/v1/workflows**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (method === 'GET' && path === '/api/v1/workflows') {
      return fulfillJson(route, { code: 200, data: { items: workflows } })
    }
    if (method === 'GET' && /^\/api\/v1\/workflows\/[^/]+\/runs$/.test(path)) {
      return fulfillJson(route, { code: 200, data: { runs: [] } })
    }
    if (method === 'PATCH' && /^\/api\/v1\/workflows\/[^/]+\/enabled$/.test(path)) {
      const workflowId = path.split('/').at(-2)
      const payload = await request.postDataJSON() as { enabled?: boolean }
      const workflow = workflows.find((item) => item.id === workflowId)
      if (workflow && typeof payload.enabled === 'boolean') workflow.enabled = payload.enabled
      return fulfillJson(route, { code: 200, data: {} })
    }
    return fulfillJson(route, { code: 200, data: {} })
  })
}

// ─── Desktop bridge mock ────────────────────────────────────────────────────

async function mockKitableTreeDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, renamedPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable Tree E2E Vault',
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
        // Rename: move the doc key and return the new WorkspaceDocument shape.
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
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, renamedPath: RENAMED_PATH, marker: DOC_MARKER },
  )

  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

// ─── Data-document API mock ─────────────────────────────────────────────────

async function mockKitableTreeDataDocumentApi(page: Page) {
  const document = structuredClone(FIXTURE_DOCUMENT)
  await page.route('**/api/v1/data-documents**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // GET /data-documents — list used by useKitableChildrenIndex
    if (method === 'GET' && /^\/api\/v1\/data-documents$/.test(path)) {
      return fulfillJson(route, {
        code: 200,
        data: {
          items: [document],
          total: 1,
          offset: 0,
          limit: 100,
        },
      })
    }

    // POST /data-documents/open — resolve path → document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: document })
    }

    // GET /data-documents/1 — full document (tables + fields + views)
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: document })
    }

    const tableMatch = path.match(/^\/api\/v1\/data-documents\/\d+\/tables\/(\d+)$/)
    if (method === 'PATCH' && tableMatch) {
      const table = document.tables.find((item) => item.id === Number(tableMatch[1]))
      const payload = await request.postDataJSON() as { title?: string }
      if (table && payload.title) table.title = payload.title
      return fulfillJson(route, { code: 200, data: table || {} })
    }

    const viewMatch = path.match(/^\/api\/v1\/data-documents\/\d+\/tables\/(\d+)\/views\/(\d+)$/)
    if (method === 'PATCH' && viewMatch) {
      const table = document.tables.find((item) => item.id === Number(viewMatch[1]))
      const view = table?.views.find((item) => item.id === Number(viewMatch[2]))
      const payload = await request.postDataJSON() as { title?: string }
      if (view && payload.title) view.title = payload.title
      return fulfillJson(route, { code: 200, data: view || {} })
    }

    // GET /data-documents/1/tables/:tableId/records
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: EMPTY_RECORDS })
    }

    // Fallback — empty success for PATCH view etc.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

// ─── Test ────────────────────────────────────────────────────────────────────

test.describe('kitable inner navigation and file-level tabs', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockKitableTreeDataDocumentApi(page)
    await mockKitableTreeDesktopBridge(page)
  })

  test('kitable opens a Feishu-style inner navigation and keeps virtual tables out of the primary tree', async ({ page }) => {
    await page.goto('/')

    // ── Wait for the sidebar tree to load ──────────────────────────────────
    // The kitable row is a .document-tree-page (not a folder node).
    const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 'Leads.kitable' })
    await expect(kitableRow).toBeVisible({ timeout: 15_000 })

    // ── (a) Body click selects the kitable and opens its Feishu-style nav ──
    await kitableRow.click()

    const visibleTabs = page.locator('.document-tab-list .document-tab')
    const kitableTab = page.locator('.document-tab-list .document-tab[data-tab-title="Leads"]')
    await expect(kitableTab).toHaveCount(1)
    const kitableTabCount = await visibleTabs.count()
    await expect(kitableRow).toHaveClass(/is-active/)
    await expect(page.getByTestId('workspace-kitable-sidebar')).toBeAttached()
    await expect(page.getByTestId('workspace-kitable-sidebar')).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('workspace-kitable-expand')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-collapsed-selector')).toHaveText(/Prospects/)
    await expect.poll(async () => page.getByTestId('workspace-kitable-sidebar').evaluate(
      (node) => Math.round(node.getBoundingClientRect().width),
    )).toBe(0)

    await page.getByTestId('workspace-kitable-expand').click()
    await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Prospects')
    await expect(page.getByTestId('workspace-kitable-workflow')).toHaveText('Workflow')
    await expect(page.getByTestId('workspace-kitable-search')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-create')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-collapse')).toBeVisible()
    await expect.poll(async () => {
      const collapseBox = await page.getByTestId('workspace-kitable-collapse').boundingBox()
      const gridViewBox = await page.getByRole('button', { name: 'Grid view' }).boundingBox()
      if (!collapseBox || !gridViewBox) return Number.POSITIVE_INFINITY
      return Math.abs(
        collapseBox.y + collapseBox.height / 2 - (gridViewBox.y + gridViewBox.height / 2),
      )
    }).toBeLessThanOrEqual(1)

    await page.getByTestId('workspace-kitable-create').click()
    await expect(page.locator('.document-create-option')).toHaveCount(2)
    await page.keyboard.press('Escape')

    await page.getByTestId('workspace-kitable-collapse').click()
    await expect(page.getByTestId('workspace-kitable-expand')).toBeVisible()
    await expect(page.getByTestId('workspace-kitable-collapsed-selector')).toHaveText(/Prospects/)
    await expect.poll(async () => page.getByTestId('workspace-kitable-sidebar').evaluate(
      (node) => Math.round(node.getBoundingClientRect().width),
    )).toBe(0)
    await expect.poll(async () => {
      const expandBox = await page.getByTestId('workspace-kitable-expand').boundingBox()
      const gridViewBox = await page.getByRole('button', { name: 'Grid view' }).boundingBox()
      if (!expandBox || !gridViewBox) return Number.POSITIVE_INFINITY
      return Math.abs(
        expandBox.y + expandBox.height / 2 - (gridViewBox.y + gridViewBox.height / 2),
      )
    }).toBeLessThanOrEqual(1)
    await expect.poll(async () => {
      const selectorBox = await page.getByTestId('workspace-kitable-collapsed-selector').boundingBox()
      const gridViewBox = await page.getByRole('button', { name: 'Grid view' }).boundingBox()
      if (!selectorBox || !gridViewBox) return Number.POSITIVE_INFINITY
      return Math.abs(
        selectorBox.y + selectorBox.height / 2 - (gridViewBox.y + gridViewBox.height / 2),
      )
    }).toBeLessThanOrEqual(1)
    await expect.poll(async () => {
      const selectorBox = await page.getByTestId('workspace-kitable-collapsed-selector').boundingBox()
      const gridViewBox = await page.getByRole('button', { name: 'Grid view' }).boundingBox()
      if (!selectorBox || !gridViewBox) return Number.NEGATIVE_INFINITY
      return gridViewBox.x - (selectorBox.x + selectorBox.width)
    }).toBeGreaterThanOrEqual(8)

    await page.getByTestId('workspace-kitable-collapsed-selector').click()
    const collapsedMenu = page.getByTestId('workspace-kitable-collapsed-menu')
    await expect(collapsedMenu).toBeVisible()
    await expect(collapsedMenu.getByRole('button', { name: 'Prospects' })).toBeVisible()
    await expect(collapsedMenu.getByRole('button', { name: 'Touchpoints' })).toBeVisible()
    await expect(collapsedMenu.getByRole('button', { name: 'Workflow' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByTestId('workspace-kitable-expand').click()
    await expect(page.getByTestId('workspace-kitable-search')).toBeVisible()

    await page.getByTestId('workspace-kitable-workflow').click()
    await expect(page.getByTestId('workflow-index-page')).toBeVisible({ timeout: 5_000 })
    await expect(kitableRow).toHaveClass(/is-active/)

    await page.getByTestId('workspace-kitable-data-table').click()
    await expect(
      page.locator('.document-data-editor-stack__pane.is-active [data-testid="kitable-editor"]'),
    ).toBeVisible({ timeout: 5_000 })

    // ── (b) Tables stay out of the primary tree and are flat inner-nav rows ──
    await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toHaveCount(0)
    const kitableNav = page.getByRole('navigation', { name: 'Kitable' })
    const dataTableItem = page.getByTestId('workspace-kitable-data-table')
    const workflowItem = page.getByTestId('workspace-kitable-workflow')
    const touchpointsItem = page.getByTestId('workspace-kitable-table-13')
    const accountsItem = page.getByTestId('workspace-kitable-table-14')
    await expect(kitableNav.getByRole('button', { name: 'Prospects' })).toHaveCount(1)
    await expect(touchpointsItem).toBeVisible()
    await expect(accountsItem).toBeVisible()
    expect(await dataTableItem.evaluate(
      (node) => node.parentElement?.parentElement?.classList.contains('workspace-kitable-sidebar__nav'),
    )).toBe(true)
    expect(await workflowItem.evaluate(
      (node) => node.parentElement?.classList.contains('workspace-kitable-sidebar__nav'),
    )).toBe(true)
    expect(await touchpointsItem.evaluate(
      (node) => node.parentElement?.parentElement?.classList.contains('workspace-kitable-sidebar__nav'),
    )).toBe(true)

    // ── (c) Default Data table maps to the first table, Prospects ───────────
    await dataTableItem.click()
    await expect(kitableTab).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(kitableTabCount)

    await page.getByTestId('data-view-menu-301').click()
    await page.getByRole('menuitem', { name: 'Rename view' }).click()
    await page.getByTestId('data-view-rename-301').fill('Prospects grid')
    await page.getByTestId('data-view-rename-301').press('Enter')
    await expect(page.getByRole('button', { name: 'Prospects grid' })).toBeVisible()

    await page.getByTestId('workspace-kitable-data-table-menu').click()
    await page.getByRole('menuitem', { name: 'Rename data table' }).click()
    await page.getByTestId('workspace-kitable-data-table-rename-input').fill('Qualified prospects')
    await page.getByTestId('workspace-kitable-data-table-rename-input').press('Enter')
    await expect(dataTableItem).toHaveText('Qualified prospects')

    // ── (d) Click "Touchpoints" → same file tab switches internal table ────
    await touchpointsItem.click()
    await expect(touchpointsItem).toHaveClass(/is-active/)
    await expect(kitableTab).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(kitableTabCount)

    // ── (e) Rename Leads.kitable → Customers.kitable via More actions ──────
    // Hover the row to reveal the action buttons, then click More actions.
    await kitableRow.hover()
    const moreActionsBtn = kitableRow.locator('.document-tree-action[aria-label="More actions"]')
    await expect(moreActionsBtn).toBeVisible({ timeout: 5_000 })
    await moreActionsBtn.click()

    // The context menu appears; click Rename.
    await page.locator('text=Rename').first().click()

    // An inline rename input takes over the row — clear and type new name.
    const renameInput = page.locator('.document-tree-rename-input')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })
    await renameInput.fill('Customers')
    await renameInput.press('Enter')

    // ── (f) The same file tab survives and follows the kitable rename ───────
    await expect(page.locator('.document-tab-list .document-tab[data-tab-title="Customers"]')).toHaveCount(1)
    await expect(visibleTabs).toHaveCount(kitableTabCount)

    // ── (g) Sidebar shows the renamed kitable row ──────────────────────────
    await expect(
      page.locator('.document-tree-row.document-tree-page', { hasText: 'Customers.kitable' }),
    ).toBeVisible({ timeout: 5_000 })

    // ── (h) The current table editor remains mounted after file rename ─────
    await expect(
      page.locator('.document-data-editor-stack__pane.is-active [data-testid="kitable-editor"]'),
    ).toBeVisible({ timeout: 15_000 })
  })

  // Regression for restoring the file-level kitable tab with its current
  // internal table view.
  test('kitable file tab survives a page reload', async ({ page }) => {
    await page.goto('/')

    // Open the kitable, then choose the default Data table (Prospects).
    const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 'Leads.kitable' })
    await expect(kitableRow).toBeVisible({ timeout: 15_000 })
    await kitableRow.click()
    await page.getByTestId('workspace-kitable-expand').click()
    const dataTableButton = page.getByTestId('workspace-kitable-data-table')
    await expect(dataTableButton).toBeEnabled()
    await dataTableButton.click()
    await expect(page.locator('.document-tab-list .document-tab[data-tab-title="Leads"]')).toHaveCount(1)
    await expect(
      page.locator('.document-data-editor-stack__pane.is-active [data-testid="kitable-editor"]'),
    ).toBeVisible({ timeout: 15_000 })

    // useWorkspaceTabs persists via an effect; wait for the write to land.
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
        if (!raw) return null
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown[]>
          const tabs = Object.values(parsed)[0] || []
          return tabs.find((t) => (t as { id: string; type: string }).id === 'kitable:Leads.kitable'
            && (t as { type: string }).type === 'table') ?? null
        } catch {
          return null
        }
      })
    }, { timeout: 5_000 }).not.toBeNull()

    // Reload — addInitScript re-runs and clears legacy keys, but workspace-tabs.v2
    // is preserved, so parseWorkspaceTabList must restore the table tab.
    await page.reload()

    // The Leads file tab must still be in the tab bar.
    const restoredTab = page.locator('.document-tab-list .document-tab[data-tab-title="Leads"]')
    await expect(restoredTab).toHaveCount(1, { timeout: 15_000 })

    // And clicking it must mount the current internal table view.
    await restoredTab.click()
    await expect(
      page.locator('.document-data-editor-stack__pane.is-active [data-testid="kitable-editor"]'),
    ).toBeVisible({ timeout: 15_000 })
  })

  test('collapsed workflow uses the same flat selector and exposes its enabled switch', async ({ page }) => {
    await mockKitableWorkflowApi(page)
    await page.goto('/')

    const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 'Leads.kitable' })
    await expect(kitableRow).toBeVisible({ timeout: 15_000 })
    await kitableRow.click()
    await page.getByTestId('workspace-kitable-expand').click()

    const workflowItem = page.getByTestId('workspace-kitable-workflow')
    const followUpItem = page.getByTestId('workspace-kitable-workflow-auto_followup')
    await expect(followUpItem).toBeVisible()
    expect(await followUpItem.evaluate(
      (node) => node.parentElement?.classList.contains('workspace-kitable-sidebar__nav'),
    )).toBe(true)

    await workflowItem.click()
    const topbar = page.getByTestId('workflow-home-topbar')
    const expandedToggle = topbar.getByTestId('status-toggle')
    await expect(topbar).toBeVisible({ timeout: 10_000 })
    await expect(expandedToggle).toBeVisible()
    await expect.poll(async () => {
      const toggleBox = await expandedToggle.boundingBox()
      const topbarBox = await topbar.boundingBox()
      if (!toggleBox || !topbarBox) return Number.POSITIVE_INFINITY
      return toggleBox.x - topbarBox.x
    }).toBeLessThanOrEqual(20)
    await page.getByTestId('workspace-kitable-collapse').click()

    const selector = page.getByTestId('workspace-kitable-collapsed-selector')
    const toggle = page.getByTestId('workspace-kitable-workflow-toggle')
    await expect(selector).toHaveText(/Workflow/)
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(await toggle.getAttribute('class')).toBe(await expandedToggle.getAttribute('class'))
    expect(await toggle.getAttribute('aria-label')).toBe(await expandedToggle.getAttribute('aria-label'))
    await expect(topbar.getByTestId('status-toggle')).toBeHidden()
    await expect.poll(async () => {
      const selectorBox = await selector.boundingBox()
      const topbarBox = await page.getByTestId('workflow-home-topbar').boundingBox()
      if (!selectorBox || !topbarBox) return Number.POSITIVE_INFINITY
      return Math.abs(
        selectorBox.y + selectorBox.height / 2 - (topbarBox.y + topbarBox.height / 2),
      )
    }).toBeLessThanOrEqual(1)
    await expect.poll(async () => {
      const toggleBox = await toggle.boundingBox()
      const topbarBox = await page.getByTestId('workflow-home-topbar').boundingBox()
      if (!toggleBox || !topbarBox) return Number.POSITIVE_INFINITY
      return Math.abs(
        toggleBox.y + toggleBox.height / 2 - (topbarBox.y + topbarBox.height / 2),
      )
    }).toBeLessThanOrEqual(1)

    await selector.click()
    const menu = page.getByTestId('workspace-kitable-collapsed-menu')
    await expect(menu.getByRole('button', { name: 'Prospects' })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Workflow' })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Lead routing' })).toHaveCount(0)
    await expect(menu.getByRole('button', { name: 'Follow-up' })).toBeVisible()
    await page.keyboard.press('Escape')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
})
