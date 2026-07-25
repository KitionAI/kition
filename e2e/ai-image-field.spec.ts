import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * AI image field e2e smoke test.
 *
 * Covers: workspace mount → document fetch → record with DataAttachment[] cell
 * value → gallery card click → RecordDetailDrawer → DataInlineCell renders the
 * AI image cell wrapper and the attachment thumbnail.
 *
 * Nothing in this test triggers real AI generation or calls a real backend. All
 * API responses are mocked at the Playwright route layer.
 */

const VAULT_PATH = '/tmp/kition-ai-image-e2e-vault'
const DOC_PATH = 'ai-image-test.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 2 })

const FIXTURE_DOCUMENT = {
  id: 2,
  user_id: 1,
  workspace_root: VAULT_PATH,
  path: DOC_PATH,
  title: 'AI Image Test',
  description: '',
  icon: '',
  color: '',
  meta: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  tables: [
    {
      id: 21,
      user_id: 1,
      document_id: 2,
      name: 'images',
      title: 'Images',
      description: '',
      order: 0,
      primary_field_id: 201,
      meta: null,
      fields: [
        {
          id: 201,
          user_id: 1,
          document_id: 2,
          table_id: 21,
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
        {
          id: 202,
          user_id: 1,
          document_id: 2,
          table_id: 21,
          name: 'ai_image',
          title: 'AI Image',
          type: 'ai',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 1,
          options: {
            ai_config: {
              enabled: true,
              action_type: 'image_generation',
              output_format: 'image',
              auto_update: false,
              source_field_name: 'title',
              image_size: '1024x1024',
              image_count: 1,
              image_quality: 'medium',
            },
          },
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      // Gallery view as the first (default) view so records are rendered as
      // real DOM <article> elements — the canvas grid's expand button is not
      // accessible from a Playwright DOM click.
      views: [
        {
          id: 301,
          user_id: 1,
          document_id: 2,
          table_id: 21,
          title: 'Gallery view',
          type: 'gallery',
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

// Record that already has a generated image attachment in the ai_image field.
const FIXTURE_RECORDS = {
  items: [
    {
      id: 2001,
      user_id: 1,
      document_id: 2,
      table_id: 21,
      row_key: 'r_img_one',
      order: 0,
      values: {
        title: 'Sunset over mountains',
        ai_image: [
          {
            name: 'gen.png',
            url: 'https://test.local/gen.png',
            mimeType: 'image/png',
            sizeBytes: 1234,
          },
        ],
      },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ],
  total: 1,
  offset: 0,
  limit: 200,
}

async function mockAIImageDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'AI Image E2E Vault',
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

async function mockAIImageDataDocumentApi(page: Page) {
  await page.route('**/api/v1/data-documents/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/open → resolve path to document
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/2 → full document with tables + fields + views
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/2/tables/21/records
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_RECORDS })
    }

    // Fallback for PATCH view config etc.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

async function waitForKitableEditor(page: Page) {
  await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 15_000 })
}

test.describe('AI image field — e2e smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockAIImageDataDocumentApi(page)
  })

  test('renders attachment thumbnail in RecordDetailDrawer for image_generation AI field', async ({
    page,
  }) => {
    await mockAIImageDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    // The gallery view renders each record as a real DOM <article>. Click the
    // first card to open the RecordDetailDrawer.
    const galleryCard = page.locator('.data-inline-gallery-card').first()
    await expect(galleryCard).toBeVisible({ timeout: 10_000 })
    await galleryCard.click()

    // The drawer should appear.
    const drawer = page.locator('.data-inline-record-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // The AI image cell wrapper must be present inside the drawer.
    const aiImageCell = drawer.locator('.data-inline-ai-cell-image')
    await expect(aiImageCell).toBeVisible({ timeout: 5_000 })

    // The attachment thumbnail button must be present in the DOM inside the AI
    // image cell. We use toBeAttached (not toBeVisible) because the button may
    // be rendered inside a scrollable sub-container that exceeds the drawer's
    // painted area; what matters for the smoke test is that the DataAttachment[]
    // value made it all the way from the API fixture to the rendered component.
    const thumbButton = aiImageCell.getByTestId('attachment-thumb')
    await expect(thumbButton).toBeAttached({ timeout: 5_000 })

    // The img inside the button must carry the exact URL from the fixture.
    // This proves the attachment URL was passed through the full render chain:
    //   API fixture → record values → DataInlineCell → AttachmentCell → img src.
    const thumbImg = thumbButton.locator('img')
    await expect(thumbImg).toHaveAttribute('src', 'https://test.local/gen.png')
  })
})
