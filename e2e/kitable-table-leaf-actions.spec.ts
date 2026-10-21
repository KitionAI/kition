import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * E2E — a kitable's table actions, where they live now.
 *
 * Tables are not rows of the primary file tree (virtual children stay out of
 * it since the Feishu-style kitable navigation, see
 * kitable-tree-expand-and-open-table.spec.ts); they are items of the kitable
 * sidebar. Their actions:
 *   1. The sidebar table item's menu offers Rename and Delete: no Create
 *      Workflow and no file-row actions (Add to chat, Duplicate, Move to, Show
 *      in Finder).
 *   2. Rename PATCHes `/v1/data-documents/1/tables/:tid` with `{title}` and the
 *      sidebar shows the new title.
 *   3. An empty or whitespace-only rename sends nothing and keeps the title.
 *   4. Delete asks first; Cancel sends no DELETE and the table stays.
 *   5. A confirmed Delete sends `DELETE /v1/data-documents/1/tables/:tid`, the
 *      table leaves the sidebar, and the other table stays.
 *   6. "New workflow" in the kitable's own `+` menu opens the mode dialog on
 *      the first table, and the person can choose the other one there.
 *
 * Pattern: inline desktop-bridge mock + inline data-document API mock with a
 * mutable list of tables, so PATCH/DELETE persist within a single test.
 */

const VAULT_PATH = '/tmp/kition-kitable-table-leaf-actions-e2e-vault'
const DOC_PATH = 't2.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

// ─── Base fixture: 2 tables (Prospects, Touchpoints) ───────────────────────

type TableFixture = {
  id: number
  title: string
  name: string
  order: number
  primaryFieldId: number
}

const INITIAL_TABLES: TableFixture[] = [
  { id: 12, title: 'Prospects', name: 'prospects', order: 0, primaryFieldId: 201 },
  { id: 13, title: 'Touchpoints', name: 'touchpoints', order: 1, primaryFieldId: 202 },
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
    fields: [
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
    ],
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

function buildDocument(tables: TableFixture[]) {
  return {
    id: 1,
    user_id: 1,
    workspace_root: VAULT_PATH,
    path: DOC_PATH,
    title: 't2',
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

async function mockDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable Leaf Actions E2E Vault',
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
    window.localStorage.removeItem('kition.document.workspace-tabs.v2')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

// ─── Data-document API mock (mutable tables + recorded calls) ──────────────

type MockApiState = {
  tables: TableFixture[]
  patchCalls: Array<{ tableId: number; payload: Record<string, unknown> }>
  deleteCalls: Array<{ tableId: number }>
}

async function mockDataDocumentApi(page: Page, state: MockApiState) {
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
          items: [buildDocument(state.tables)],
          total: 1,
          offset: 0,
          limit: 100,
        },
      })
    }

    // POST /data-documents/open — resolve path → document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: buildDocument(state.tables) })
    }

    // GET /data-documents/1 — full document (tables + fields + views)
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: buildDocument(state.tables) })
    }

    // PATCH /data-documents/1/tables/:tableId — rename
    const tablesMatch = path.match(/^\/api\/v1\/data-documents\/\d+\/tables\/(\d+)$/)
    if (method === 'PATCH' && tablesMatch) {
      const tableId = Number(tablesMatch[1])
      const payload = (await request.postDataJSON()) as Record<string, unknown>
      state.patchCalls.push({ tableId, payload })
      const idx = state.tables.findIndex((t) => t.id === tableId)
      if (idx >= 0 && typeof payload.title === 'string' && payload.title.trim()) {
        state.tables[idx] = { ...state.tables[idx], title: String(payload.title).trim() }
      }
      const table = state.tables.find((t) => t.id === tableId)
      return fulfillJson(route, {
        code: 200,
        data: table ? buildTable(table) : { id: tableId, ...payload },
      })
    }

    // DELETE /data-documents/1/tables/:tableId — delete
    if (method === 'DELETE' && tablesMatch) {
      const tableId = Number(tablesMatch[1])
      state.deleteCalls.push({ tableId })
      state.tables = state.tables.filter((t) => t.id !== tableId)
      return fulfillJson(route, { code: 200, data: {} })
    }

    // GET /data-documents/1/tables/:tableId/records
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: EMPTY_RECORDS })
    }

    // GET /data-documents/1/tables/:tableId/fields — schema fetch for template
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/fields$/.test(path)) {
      return fulfillJson(route, {
        code: 200,
        data: {
          items: [
            { id: 201, name: 'name', title: 'Name', type: 'text' },
            { id: 202, name: 'email', title: 'Email', type: 'text' },
          ],
        },
      })
    }

    // Fallback — empty success for PATCH view etc.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

// ─── Shared setup ──────────────────────────────────────────────────────────

function freshState(): MockApiState {
  return {
    tables: INITIAL_TABLES.map((t) => ({ ...t })),
    patchCalls: [],
    deleteCalls: [],
  }
}

async function openKitableSidebar(page: Page) {
  await page.goto('/')
  const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 't2.kitable' })
  await expect(kitableRow).toBeVisible({ timeout: 15_000 })
  await kitableRow.click()
  // The kitable opens with its sidebar collapsed; the top bar's control expands it.
  const expand = page.getByRole('button', { name: 'Expand table file sidebar' })
  await expect(expand).toBeVisible({ timeout: 10_000 })
  await expand.click()
  await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Prospects', { timeout: 10_000 })
  await expect(page.getByTestId('workspace-kitable-table-13')).toHaveText('Touchpoints')
}

async function openTableMenu(page: Page) {
  await page.getByTestId('workspace-kitable-data-table-menu').click()
  const menu = page.locator('.workspace-kitable-sidebar__item-menu')
  await expect(menu).toBeVisible({ timeout: 5_000 })
  return menu
}

async function startRename(page: Page) {
  const menu = await openTableMenu(page)
  await menu.getByRole('menuitem', { name: 'Rename data table' }).click()
  const input = page.getByTestId('workspace-kitable-data-table-rename-input')
  await expect(input).toBeVisible({ timeout: 5_000 })
  return input
}

async function deleteFromSidebar(page: Page) {
  const menu = await openTableMenu(page)
  await menu.getByRole('menuitem', { name: 'Delete data table' }).click()
  const dialog = page.getByTestId('kitable-table-delete-confirm')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByTestId('confirm-message')).toContainText('Delete table "Prospects"?')
  return dialog
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('kitable table actions', () => {
  let state: MockApiState

  test.beforeEach(async ({ page }) => {
    state = freshState()
    await mockLocalWorkspaceApi(page)
    await mockDataDocumentApi(page, state)
    await mockDesktopBridge(page)
  })

  test('A1 — the sidebar table menu offers Rename and Delete only, and tables are not file-tree rows', async ({ page }) => {
    await openKitableSidebar(page)
    // Tables are kitable sidebar items, never rows of the primary tree.
    await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toHaveCount(0)

    const menu = await openTableMenu(page)
    await expect(menu.getByRole('menuitem')).toHaveCount(2)
    await expect(menu.getByRole('menuitem', { name: 'Rename data table' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Delete data table' })).toBeVisible()
    for (const label of ['Create Workflow', 'New workflow', 'Add to chat', 'Duplicate', 'Move to...', 'Show in Finder', 'Change icon']) {
      await expect(menu.getByText(label, { exact: true })).toHaveCount(0)
    }
  })

  test('A2 — Rename PATCHes the table and the sidebar shows the new title', async ({ page }) => {
    await openKitableSidebar(page)
    const input = await startRename(page)
    await input.fill('Leads')
    await input.press('Enter')

    await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Leads', { timeout: 5_000 })
    await expect.poll(() => state.patchCalls.length).toBe(1)
    expect(state.patchCalls[0]?.tableId).toBe(12)
    expect(state.patchCalls[0]?.payload).toMatchObject({ title: 'Leads' })
    expect(state.deleteCalls).toHaveLength(0)
  })

  test('A3 — an empty rename sends nothing and keeps the title', async ({ page }) => {
    await openKitableSidebar(page)
    const input = await startRename(page)
    await input.fill('   ')
    await input.press('Enter')

    await expect(input).toHaveCount(0)
    await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Prospects')
    expect(state.patchCalls).toHaveLength(0)
  })

  test('A4 — Delete asks first; Cancel sends no DELETE and the table stays', async ({ page }) => {
    await openKitableSidebar(page)
    const dialog = await deleteFromSidebar(page)
    await dialog.getByTestId('cancel-btn').click()

    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Prospects')
    expect(state.deleteCalls).toHaveLength(0)
  })

  test('A5 — a confirmed Delete sends DELETE and the table leaves the sidebar', async ({ page }) => {
    await openKitableSidebar(page)
    const dialog = await deleteFromSidebar(page)
    await dialog.getByTestId('confirm-btn').click()

    await expect.poll(() => state.deleteCalls.length).toBe(1)
    expect(state.deleteCalls[0]?.tableId).toBe(12)
    expect(state.patchCalls).toHaveLength(0)
    // Prospects is gone; Touchpoints, the remaining table, leads the sidebar.
    await expect(page.locator('.workspace-kitable-sidebar').getByText('Prospects', { exact: true })).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('workspace-kitable-data-table')).toHaveText('Touchpoints')
  })

  test('A6 — New workflow in the kitable + menu opens the mode dialog on a table the person can change', async ({ page }) => {
    // Two tables: the dialog starts on the first and offers both as the trigger table.
    await openKitableSidebar(page)
    await page.getByTestId('workspace-kitable-create').click()
    await page.getByTestId('kitable-action-create-workflow').click()

    const modeDialog = page.locator('[data-testid="workspace-workflow-create-mode-dialog"]')
    await expect(modeDialog).toBeVisible({ timeout: 5_000 })
    await expect(modeDialog.locator('[data-testid="create-mode-template"]')).toBeVisible()
    await expect(modeDialog.locator('[data-testid="create-mode-chat"]')).toBeVisible()
    await expect(modeDialog).toHaveAttribute('data-context-table-name', 'Prospects')
    await expect(modeDialog).toHaveAttribute('data-context-table-id', '12')
    await expect(modeDialog).toHaveAttribute('data-context-document-id', '1')

    const source = page.getByTestId('workflow-create-source-table')
    await expect(source.locator('option')).toHaveText(['Prospects', 'Touchpoints'])
    await source.selectOption('13')
    await expect(modeDialog).toHaveAttribute('data-context-table-id', '13')
    await expect(modeDialog).toHaveAttribute('data-context-table-name', 'Touchpoints')
  })

})
