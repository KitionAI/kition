import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * Edit field sheet e2e visual snapshot test.
 *
 * Covers: workspace mount → document fetch → grid view renders → click column
 * header menu chevron (canvas hit-test) → "Edit field" DOM menu item → RightSheet
 * slides open with AI config card visible for an attachment field that has
 * ai_config.enabled = true.
 *
 * Nothing in this test calls a real backend. All API responses are mocked at
 * the Playwright route layer.
 *
 * Grid coordinate math (all in logical CSS pixels relative to [data-t-grid-stage]):
 *   columnInitSize  = Math.max(rowControlCount=3, 2) × iconSizeMD(24) = 72
 *   column 0 width  = 200 (DEFAULT_COLUMN_WIDTH from useGridAdapter.ts)  →  [72 … 272)
 *   column 1 width  = 200  →  [272 … 472)
 *   columnMenuX     = 472 − columnHeadPadding/2(4) − iconSizeXS(16) = 452
 *   hit region      = [452, 468)  →  center x = 460
 *   header y center = 32 / 2 = 16
 */

const VAULT_PATH = '/tmp/kition-field-edit-sheet-e2e-vault'
const DOC_PATH = 'field-edit-sheet-test.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 3 })

const FIXTURE_DOCUMENT = {
  id: 3,
  user_id: 1,
  workspace_root: VAULT_PATH,
  path: DOC_PATH,
  title: 'Field Edit Sheet Test',
  description: '',
  icon: '',
  color: '',
  meta: null,
  created_at: '2026-06-12T00:00:00.000Z',
  updated_at: '2026-06-12T00:00:00.000Z',
  tables: [
    {
      id: 31,
      user_id: 1,
      document_id: 3,
      name: 'items',
      title: 'Items',
      description: '',
      order: 0,
      primary_field_id: 301,
      meta: null,
      fields: [
        {
          id: 301,
          user_id: 1,
          document_id: 3,
          table_id: 31,
          name: 'title',
          title: 'Title',
          type: 'text',
          required: false,
          unique: false,
          readonly: false,
          is_primary: true,
          order: 0,
          options: null,
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
        {
          id: 302,
          user_id: 1,
          document_id: 3,
          table_id: 31,
          name: 'files',
          title: 'Files',
          // type: 'attachment' so supportsAI = true and the AI config card renders.
          // The AI gate check in FieldConfigPanel is based on field.type === 'attachment'
          // (supportsAI) AND options.ai_config.enabled = true.
          type: 'attachment',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 1,
          options: {
            ai_config: {
              enabled: true,
              action_type: 'summarize',
              output_format: 'text',
              auto_update: false,
              source_field_name: 'title',
            },
          },
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      // Use a grid view (not gallery) so the canvas grid renders with column
      // headers that expose the chevron menu trigger.
      views: [
        {
          id: 401,
          user_id: 1,
          document_id: 3,
          table_id: 31,
          title: 'Grid view',
          type: 'grid',
          order: 0,
          locked: false,
          config: {},
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
      ],
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    },
  ],
}

const FIXTURE_RECORDS = {
  items: [
    {
      id: 3001,
      user_id: 1,
      document_id: 3,
      table_id: 31,
      row_key: 'r_item_one',
      order: 0,
      values: {
        title: 'Sample item',
        files: [],
      },
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T00:00:00.000Z',
    },
  ],
  total: 1,
  offset: 0,
  limit: 200,
}

async function mockFieldEditSheetDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Field Edit Sheet E2E Vault',
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

async function mockFieldEditSheetDataDocumentApi(page: Page) {
  await page.route('**/api/v1/data-documents/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/open → resolve path to document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/3 → full document with tables + fields + views
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/3/tables/31/records
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_RECORDS })
    }

    // Fallback for PATCH view config, field updates, etc.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

async function waitForKitableEditor(page: Page) {
  await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 15_000 })
}

test.describe('Edit field sheet — e2e visual snapshot', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockFieldEditSheetDataDocumentApi(page)
  })

  test('Edit field sheet matches visual snapshot', async ({ page }) => {
    await mockFieldEditSheetDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    // Wait for the grid to render (the stage div is the interaction surface)
    const gridStage = page.locator('[data-t-grid-stage]')
    await expect(gridStage).toBeVisible({ timeout: 15_000 })

    // Give the grid time to fully paint (canvas rendering + sprite loading)
    await page.waitForTimeout(500)

    // -----------------------------------------------------------------------
    // Click the column header menu chevron for the "Files" (attachment) column.
    //
    // The chevron is drawn on the canvas at a computed pixel offset.
    // We use page.mouse.move() first so the canvas InteractionLayer's useMouse()
    // hook captures the element-relative coordinates, then we click.
    //
    // Column layout (all px, CSS logical pixels):
    //   columnInitSize = max(3 row controls, 2) × 24px (iconSizeMD) = 72
    //   column 0 (title): [72 … 272)  (DEFAULT_COLUMN_WIDTH = 200 from useGridAdapter.ts)
    //   column 1 (files):  [272 … 472)
    //   columnMenuX = 472 − 4 (columnHeadPadding/2) − 16 (iconSizeXS) = 452
    //   hit area: [452, 468), center x = 460; header center y = 16
    // -----------------------------------------------------------------------
    const stageBox = await gridStage.boundingBox()
    if (!stageBox) throw new Error('Could not find grid stage bounding box')

    const chevronX = stageBox.x + 460
    const chevronY = stageBox.y + 16

    // Move first to set mousePosition in the React component, then click
    await page.mouse.move(chevronX, chevronY)
    await page.waitForTimeout(50)
    await page.mouse.click(chevronX, chevronY)

    // The TableColumnHeaderMenu DOM element should appear
    const columnMenu = page.locator('[data-testid="kitable-column-header-menu"]')
    await expect(columnMenu).toBeVisible({ timeout: 5_000 })

    // Click "Edit field" in the menu
    await columnMenu.getByText('Edit field').click()

    // The RightSheet should slide in
    const sheet = page.locator('[data-testid="right-sheet"]')
    await expect(sheet).toBeVisible({ timeout: 5_000 })

    // Verify the sheet title
    await expect(sheet).toContainText('Edit field')

    // Verify the AI config card is present (attachment field with ai_config.enabled = true)
    await expect(sheet).toContainText('AI config')

    // Wait for the slide-in animation to finish (200ms transition + buffer)
    await page.waitForTimeout(300)

    // Visual snapshot — maxDiffPixelRatio allows minor anti-aliasing differences
    await expect(sheet).toHaveScreenshot('field-edit-sheet.png', { maxDiffPixelRatio: 0.02 })
  })
})
