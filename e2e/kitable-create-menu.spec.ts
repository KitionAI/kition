import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * E2E — a .kitable row's "+" create menu.
 *
 * The menu creates what lives inside the kitable: "New table", and "New
 * workflow", which asks for the trigger table in the mode dialog. Creating a
 * table never creates a workflow.
 *
 * Pattern: inline desktop-bridge mock + inline data-document API mock, identical
 * to the pattern established in kitable-tree-expand-and-open-table.spec.ts.
 */

const VAULT_PATH = '/tmp/kition-kitable-create-menu-e2e-vault'
const DOC_PATH = 'Leads.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

// ─── Base fixture: 1 table ──────────────────────────────────────────────────

function makeBaseDocument(extraTables: Array<Record<string, unknown>> = []) {
  return {
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
      ...extraTables,
    ],
  }
}

const EMPTY_RECORDS = { items: [], total: 0, offset: 0, limit: 200 }

// ─── Desktop-bridge mock ────────────────────────────────────────────────────

async function mockDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable Create Menu E2E Vault',
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
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, marker: DOC_MARKER },
  )

  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

// ─── Data-document API mock (mutable state for POST /tables) ────────────────

async function mockDataDocumentApi(page: Page) {
  // Mutable list of extra tables created during the test.
  // Starts empty; POST /tables appends here; GET /data-documents and
  // GET /data-documents/1 read from it on every request.
  const createdTables: Array<Record<string, unknown>> = []
  let nextTableId = 20

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
          items: [makeBaseDocument(createdTables)],
          total: 1,
          offset: 0,
          limit: 100,
        },
      })
    }

    // POST /data-documents/open — resolve path → document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: makeBaseDocument(createdTables) })
    }

    // GET /data-documents/1 — full document (tables + fields + views)
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: makeBaseDocument(createdTables) })
    }

    // POST /data-documents/1/tables — create a new table
    if (method === 'POST' && /^\/api\/v1\/data-documents\/\d+\/tables$/.test(path)) {
      const payload = (await request.postDataJSON()) as { title?: string }
      const tableId = nextTableId++
      const newTable = {
        id: tableId,
        user_id: 1,
        document_id: 1,
        name: (payload.title || 'Untitled table').toLowerCase().replace(/\s+/g, '_'),
        title: payload.title || 'Untitled table',
        description: '',
        order: 1 + createdTables.length,
        primary_field_id: 900 + tableId,
        meta: null,
        fields: [
          {
            id: 900 + tableId,
            user_id: 1,
            document_id: 1,
            table_id: tableId,
            name: 'name',
            title: 'Name',
            type: 'text',
            required: false,
            unique: false,
            readonly: false,
            is_primary: true,
            order: 0,
            options: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        views: [
          {
            id: 800 + tableId,
            user_id: 1,
            document_id: 1,
            table_id: tableId,
            title: 'Grid view',
            type: 'grid',
            order: 0,
            locked: false,
            config: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      createdTables.push(newTable)
      return fulfillJson(route, { code: 200, data: newTable })
    }

    // GET /data-documents/1/tables/:tableId/records
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: EMPTY_RECORDS })
    }

    // Fallback — empty success for PATCH view etc.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

// ─── Shared setup helper ─────────────────────────────────────────────────────

async function openKitableCreateMenu(page: Page) {
  // Navigate fresh and wait for the kitable row.
  await page.goto('/')
  const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 'Leads.kitable' })
  await expect(kitableRow).toBeVisible({ timeout: 15_000 })

  // Hover the row to reveal action buttons, then click the "+" (Create inside).
  await kitableRow.hover()
  const createInsideBtn = kitableRow.locator('[aria-label="Create inside this page"]')
  await expect(createInsideBtn).toBeVisible({ timeout: 5_000 })
  await createInsideBtn.click()

  // The WorkspaceCreateMenu (kitable variant) anchored to the row's + should now be open.
  await expect(page.locator('.document-create-menu')).toBeVisible({ timeout: 5_000 })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('kitable + create menu', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockDataDocumentApi(page)
    await mockDesktopBridge(page)
  })

  test('kitable + opens a menu with New table and New workflow, nothing else', async ({ page }) => {
    await openKitableCreateMenu(page)

    // A .kitable row's + creates what lives inside it: a table, or a workflow
    // on one of its tables ("New workflow"). File kinds such as
    // documents or folders do not belong here.
    const menu = page.locator('.document-create-menu')
    await expect(menu.locator('button')).toHaveCount(2)
    await expect(menu.locator('button', { hasText: 'New table' })).toBeVisible()
    await expect(menu.getByTestId('kitable-action-create-workflow')).toHaveText('New workflow')
    await expect(menu.locator('button', { hasText: 'New document' })).toHaveCount(0)
    await expect(menu.locator('button', { hasText: 'Folder' })).toHaveCount(0)
  })

  test('New table creates and auto-opens; no workflow API calls fire', async ({ page }) => {
    // New table creates and opens a table, and no POST /v1/workflows leaks
    // from it. How the sidebar lists the new table is covered by the
    // kitable-table-leaf-actions spec's rename and delete tests.
    const workflowPosts: string[] = []
    await page.route('**/api/v1/workflows**', async (route) => {
      if (route.request().method() === 'POST') {
        workflowPosts.push(route.request().url())
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 200, data: { items: [] } }),
      })
    })

    await openKitableCreateMenu(page)
    const menu = page.locator('.document-create-menu')
    await menu.locator('button', { hasText: 'New table' }).click()

    // The new table opens inside the existing Leads.kitable file tab.
    await expect(
      page.locator('.document-tab-list .document-tab[data-tab-title="Leads"]'),
    ).toHaveCount(1, { timeout: 10_000 })
    await expect(
      page.locator('.document-tab-list .document-tab[data-tab-title="Untitled table"]'),
    ).toHaveCount(0)

    // And no POST /v1/workflows fired anywhere along the way.
    expect(workflowPosts).toEqual([])
  })
})
