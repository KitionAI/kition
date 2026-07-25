import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * E2E — Group A: virtual `table://` leaf "..." menu on a kitable.
 *
 * Asserts the new per-table-leaf actions added by the kitable refactor:
 *   1. Hovering a virtual `table://` row reveals the "More actions" button, and
 *      the menu exposes exactly Rename / Delete / Create Workflow. Workspace
 *      file-row actions like "Add to chat", "Duplicate", "Move to", "Show in
 *      Finder" must NOT appear (the leaves are virtual nodes).
 *   2. Rename routes through `PATCH /v1/data-documents/1/tables/:tid` with
 *      `{title}` and updates both the sidebar row and any open `table:` tab.
 *   3. Empty / whitespace-only rename short-circuits — no PATCH fires, the row
 *      keeps its original title.
 *   4. Delete pops a destructive confirm dialog; Cancel does NOT call DELETE
 *      and leaves the row visible.
 *   5. Confirmed Delete fires `DELETE /v1/data-documents/1/tables/:tid`, removes
 *      the row from the sidebar, closes the matching open tab, and clears the
 *      activeResourcePath (no stale virtual path in workspace-tabs.v2).
 *   6. "Create Workflow" from the menu opens the mode chooser dialog
 *      pre-resolved to the selected table — no table picker appears.
 *
 * Pattern: inline desktop-bridge mock + inline data-document API mock,
 * identical to kitable-tree-expand-and-open-table.spec.ts. The data-document
 * mock now owns a mutable list of tables so PATCH/DELETE persist within a
 * single test.
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

async function expandKitable(page: Page) {
  await page.goto('/')
  const kitableRow = page.locator('.document-tree-row.document-tree-page', { hasText: 't2.kitable' })
  await expect(kitableRow).toBeVisible({ timeout: 15_000 })
  await kitableRow.click()
  // Wait until child rows are visible — useKitableChildrenIndex has loaded.
  await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toBeVisible({ timeout: 10_000 })
}

async function openTableLeafActionMenu(page: Page, title: string) {
  const row = page.locator('.document-tree-row', { hasText: title }).first()
  await row.hover()
  const moreActionsBtn = row.locator('.document-tree-action[aria-label="More actions"]')
  await expect(moreActionsBtn).toBeVisible({ timeout: 5_000 })
  await moreActionsBtn.click()
  // The menu sits as a sibling of the moreActions button — bind by testid'd
  // entries to avoid matching the outer tree menu of other rows.
  await expect(page.locator('[data-testid="kitable-table-action-rename"]')).toBeVisible({ timeout: 5_000 })
}

async function openKitableContainerCreateMenu(page: Page) {
  // The kitable container ("t2.kitable") owns its own inline `+` menu where
  // Create Workflow now lives (previously it sat inside the "..." menu). We
  // hover the container row, then click the Create inside button — its
  // onClick stops propagation so the row's expansion state is untouched.
  const containerRow = page.locator('.document-tree-row.document-tree-page', { hasText: 't2.kitable' })
  await expect(containerRow).toBeVisible({ timeout: 5_000 })
  await containerRow.hover()
  const createBtn = containerRow.locator('.document-tree-action[aria-label="Create inside this page"]')
  await expect(createBtn).toBeVisible({ timeout: 5_000 })
  await createBtn.click()
  await expect(page.locator('[data-testid="kitable-action-create-workflow"]')).toBeVisible({ timeout: 5_000 })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('kitable virtual table leaf "..." menu', () => {
  let state: MockApiState

  test.beforeEach(async ({ page }) => {
    state = freshState()
    await mockLocalWorkspaceApi(page)
    await mockDataDocumentApi(page, state)
    await mockDesktopBridge(page)
  })

  test('A1 — leaf table "..." menu exposes only Rename / Delete (no Create Workflow)', async ({ page }) => {
    await expandKitable(page)
    await openTableLeafActionMenu(page, 'Prospects')

    // The two table-leaf actions remain on the leaf menu.
    await expect(page.locator('[data-testid="kitable-table-action-rename"]')).toBeVisible()
    await expect(page.locator('[data-testid="kitable-table-action-delete"]')).toBeVisible()

    // Create Workflow has been moved up to the .kitable container row's
    // menu — it must NOT appear on a table leaf anymore.
    await expect(page.locator('[data-testid="kitable-table-action-create-workflow"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="kitable-action-create-workflow"]')).toHaveCount(0)

    // File-row-only actions must NOT appear on a virtual leaf — they make no
    // sense (no underlying file path, no duplicate semantics, etc.).
    const menu = page.locator('.document-tree-menu').first()
    await expect(menu.locator('text=Add to chat')).toHaveCount(0)
    await expect(menu.locator('text=Duplicate')).toHaveCount(0)
    await expect(menu.locator('text=Move to...')).toHaveCount(0)
    await expect(menu.locator('text=Show in Finder')).toHaveCount(0)
    await expect(menu.locator('text=Change icon')).toHaveCount(0)
    await expect(menu.locator('text=Create Workflow')).toHaveCount(0)
  })

  test('A2 — Rename PATCHes the table and updates sidebar row + open tab', async ({ page }) => {
    await expandKitable(page)

    // Open the Prospects tab so the rename has a live tab to update.
    await page.locator('.document-tree-row', { hasText: 'Prospects' }).first().click()
    await expect(page.locator('.document-tab-bar [data-tab-title="Prospects"]')).toBeVisible({ timeout: 5_000 })

    await openTableLeafActionMenu(page, 'Prospects')
    await page.locator('[data-testid="kitable-table-action-rename"]').click()

    const renameInput = page.locator('.document-tree-rename-input')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })
    await renameInput.fill('Leads')
    await renameInput.press('Enter')

    // Sidebar row reflects new title.
    await expect(page.locator('.document-tree-row', { hasText: 'Leads' })).toBeVisible({ timeout: 5_000 })

    // The open tab inherits the new title.
    await expect(page.locator('.document-tab-bar [data-tab-title="Leads"]')).toBeVisible({ timeout: 5_000 })

    // Exactly one PATCH with the renamed title; no DELETE leaked.
    expect(state.patchCalls).toHaveLength(1)
    expect(state.patchCalls[0]?.tableId).toBe(12)
    expect(state.patchCalls[0]?.payload).toMatchObject({ title: 'Leads' })
    expect(state.deleteCalls).toHaveLength(0)
  })

  test('A3 — empty rename input short-circuits, no PATCH fires', async ({ page }) => {
    await expandKitable(page)
    await openTableLeafActionMenu(page, 'Prospects')
    await page.locator('[data-testid="kitable-table-action-rename"]').click()

    const renameInput = page.locator('.document-tree-rename-input')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })

    // Whitespace-only input — useKitableTableLeafActions.renameKitableTableLeaf
    // bails on trimmed empty string.
    await renameInput.fill('   ')
    await renameInput.press('Enter')

    // Rename input is dismissed (renameWorkspaceNode end), and the row keeps
    // its original title.
    await expect(renameInput).toHaveCount(0)
    await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toBeVisible()
    expect(state.patchCalls).toHaveLength(0)
  })

  test('A4 — Delete cancel does NOT call DELETE, row stays', async ({ page }) => {
    await expandKitable(page)
    await openTableLeafActionMenu(page, 'Prospects')
    await page.locator('[data-testid="kitable-table-action-delete"]').click()

    // Confirm dialog appears with the dedicated testid from useKitableTableLeafActions.
    const confirmDialog = page.locator('[data-testid="kitable-table-delete-confirm"]')
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 })

    // Click Cancel — the confirm dialog's Cancel button carries `cancel-btn`.
    await confirmDialog.locator('[data-testid="cancel-btn"]').click()

    // Dialog gone, no DELETE, row still listed.
    await expect(confirmDialog).toHaveCount(0)
    await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toBeVisible()
    expect(state.deleteCalls).toHaveLength(0)
  })

  test('A5 — confirmed Delete calls DELETE, removes node, closes tab', async ({ page }) => {
    await expandKitable(page)

    // Open the Prospects tab first so we can verify it's closed after delete.
    await page.locator('.document-tree-row', { hasText: 'Prospects' }).first().click()
    await expect(page.locator('.document-tab-bar [data-tab-title="Prospects"]')).toBeVisible({ timeout: 5_000 })

    await openTableLeafActionMenu(page, 'Prospects')
    await page.locator('[data-testid="kitable-table-action-delete"]').click()

    const confirmDialog = page.locator('[data-testid="kitable-table-delete-confirm"]')
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 })
    await confirmDialog.locator('[data-testid="confirm-btn"]').click()

    // DELETE fired for the Prospects table id (12).
    await expect.poll(() => state.deleteCalls.length).toBe(1)
    expect(state.deleteCalls[0]?.tableId).toBe(12)

    // The Prospects row disappears from the sidebar.
    await expect(page.locator('.document-tree-row', { hasText: 'Prospects' })).toHaveCount(0, { timeout: 5_000 })

    // The open tab is closed too — workspace-tabs.v2 has no entry pointing at
    // the deleted virtual path.
    await expect(page.locator('.document-tab-bar [data-tab-title="Prospects"]')).toHaveCount(0, { timeout: 5_000 })
    const persistedTabs = await page.evaluate(() => {
      const raw = window.localStorage.getItem('kition.document.workspace-tabs.v2')
      if (!raw) return []
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown[]>
        return Object.values(parsed)[0] || []
      } catch {
        return []
      }
    })
    expect(
      persistedTabs.some(
        (tab) => (tab as { type: string; tableId?: number }).type === 'table' && (tab as { tableId?: number }).tableId === 12,
      ),
    ).toBe(false)

    // The sibling table (Touchpoints) is still listed.
    await expect(page.locator('.document-tree-row', { hasText: 'Touchpoints' })).toBeVisible()
  })

  test('A6 — Create Workflow from the .kitable container menu picks a table then opens mode dialog', async ({ page }) => {
    // The fixture has 2 tables (Prospects + Touchpoints), so clicking Create
    // Workflow on the container row should defer to the table picker so the
    // user can choose the scope.
    await expandKitable(page)
    await openKitableContainerCreateMenu(page)
    await page.locator('[data-testid="kitable-action-create-workflow"]').click()

    // Picker shows up first, scoped to t2.kitable (both tables present).
    const pickerOptions = page.locator('[data-testid="workflow-table-picker-options"]')
    await expect(pickerOptions).toBeVisible({ timeout: 5_000 })
    await expect(pickerOptions.locator('[data-testid="workflow-table-picker-option"]', { hasText: 'Prospects' })).toBeVisible()
    await expect(pickerOptions.locator('[data-testid="workflow-table-picker-option"]', { hasText: 'Touchpoints' })).toBeVisible()

    // The mode chooser dialog has not shown up yet — it only opens after we
    // pick a table.
    await expect(page.locator('[data-testid="workspace-workflow-create-mode-dialog"]')).toHaveCount(0)

    await pickerOptions.locator('[data-testid="workflow-table-picker-option"]', { hasText: 'Prospects' }).click()

    const modeDialog = page.locator('[data-testid="workspace-workflow-create-mode-dialog"]')
    await expect(modeDialog).toBeVisible({ timeout: 5_000 })

    // Both mode choices are present — no "Start From Scratch".
    await expect(modeDialog.locator('[data-testid="create-mode-template"]')).toBeVisible()
    await expect(modeDialog.locator('[data-testid="create-mode-chat"]')).toBeVisible()

    // Context is pre-resolved from the picker selection — the dialog surfaces
    // it via a data attribute for e2e to inspect without depending on copy.
    await expect(modeDialog).toHaveAttribute('data-context-table-name', 'Prospects')
    await expect(modeDialog).toHaveAttribute('data-context-table-id', '12')
    await expect(modeDialog).toHaveAttribute('data-context-document-id', '1')
  })
})
