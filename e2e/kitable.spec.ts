import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'

   
                                    
  
      
                                                                                         
                                                                                  
                                                                    
                                                                  
                                               
                                                      
  
                       
                                                              
                                                                   
  
        
                                                                           
                                                           
                                                     
                                                                             
                           
   

const VAULT_PATH = '/tmp/kition-kitable-e2e-vault'
const DOC_PATH = 'table-test.kitable'
const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

const FIXTURE_DOCUMENT = {
  id: 1,
  user_id: 1,
  workspace_root: VAULT_PATH,
  path: DOC_PATH,
  title: 'Table Test',
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
      name: 'tasks',
      title: 'Tasks',
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
        {
          id: 102,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          name: 'score',
          title: 'Score',
          type: 'rating',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 1,
          options: { max: 5, icon: 'star' },
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 103,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          name: 'received_at',
          title: 'Received At',
          type: 'datetime',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 2,
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
          title: 'All tasks',
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

const FIXTURE_RECORDS = {
  items: [
    {
      id: 1001,
      user_id: 1,
      document_id: 1,
      table_id: 11,
      row_key: 'r_one',
      order: 0,
      values: { title: 'Phase 2 wrap', score: 4, received_at: '2026-07-23T04:14:47Z' },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 1002,
      user_id: 1,
      document_id: 1,
      table_id: 11,
      row_key: 'r_two',
      order: 1,
      values: { title: 'Phase 3 deferred', score: 0, received_at: '2026-07-24T05:15:48Z' },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ],
  total: 2,
  offset: 0,
  limit: 200,
}

async function mockKitableDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable E2E Vault',
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

async function mockKitableDataDocumentApi(page: Page) {
  await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return fulfillJson(route, {
      code: 200,
      data: { items: [FIXTURE_DOCUMENT], total: 1, offset: 0, limit: 200 },
    })
  })

  await page.route('**/api/v1/data-documents/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/open → resolve a path to the doc
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/1 → full document with embedded tables + fields + views
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/1/tables/11/records?limit=
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_RECORDS })
    }

    // Fallback for anything else under data-documents (PATCH view, etc.) — empty success.
    return fulfillJson(route, { code: 200, data: {} })
  })
}

async function waitForKitableEditor(page: Page) {
  await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 15_000 })
}

test.describe('kitable editor — toolbar interactions', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockKitableDataDocumentApi(page)
  })

  test('opens a .kitable file and mounts the TableEditor shell', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    await expect(page.locator('.data-inline-title-block')).toHaveCount(0)
    await expect(page.locator('.data-inline-topbar .data-inline-icon-button')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Grid view' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All tasks' })).toHaveCount(0)
    await expect(page.locator('.data-inline-view-tabs')).toBeVisible()
  })

  test('loads the complete record set without the legacy 300-row window', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    const largeRecordSet = Array.from({ length: 1_137 }, (_, index) => ({
      id: 2_000 + index,
      user_id: 1,
      document_id: 1,
      table_id: 11,
      row_key: `large_${index}`,
      order: index,
      values: { title: `Message ${String(index + 1).padStart(4, '0')}`, score: index % 6 },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    }))
    await page.route('**/api/v1/data-documents/1/tables/11/records**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      return fulfillJson(route, {
        code: 200,
        data: { items: largeRecordSet, total: largeRecordSet.length, offset: 0, limit: 0 },
      })
    })
    const recordsRequest = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return request.method() === 'GET'
        && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(url.pathname)
    })

    await page.goto('/')
    await waitForKitableEditor(page)

    const request = await recordsRequest
    const url = new URL(request.url())
    expect(url.searchParams.has('limit')).toBe(false)
    expect(url.searchParams.has('offset')).toBe(false)

    const footer = page.locator('.data-inline-footer')
    await expect(footer).toContainText('1137 records')

    await page.getByTestId('kitable-toolbar-sort').click()
    await page.getByTestId('kitable-toolbar-sort-menu').getByRole('button', { name: 'Add another sort' }).click()
    await expect(page.getByTestId('kitable-toolbar-sort')).toContainText('Sort (1)')
    await expect(footer).toContainText('1137 records')
  })

  test('exposes data-testid markers for every grid toolbar control', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    await expect(page.getByTestId('kitable-toolbar-filter')).toBeVisible()
    await expect(page.getByTestId('kitable-toolbar-sort')).toBeVisible()
    await expect(page.getByTestId('kitable-toolbar-group')).toBeVisible()
    await expect(page.getByTestId('kitable-toolbar-row-height')).toBeVisible()
    await expect(page.getByTestId('kitable-toolbar-freeze')).toBeVisible()
    await expect(page.getByTestId('kitable-toolbar-search')).toBeVisible()
  })

  test('Filter popover opens, shows the menu, and closes on second click', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const filterButton = page.getByTestId('kitable-toolbar-filter')
    await expect(page.getByTestId('kitable-toolbar-filter-menu')).toHaveCount(0)

    await filterButton.click()
    await expect(page.getByTestId('kitable-toolbar-filter-menu')).toBeVisible()

    await filterButton.click()
    await expect(page.getByTestId('kitable-toolbar-filter-menu')).toHaveCount(0)
  })

  test('Sort and Group popovers each open their menu when clicked', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    await page.getByTestId('kitable-toolbar-sort').click()
    await expect(page.getByTestId('kitable-toolbar-sort-menu')).toBeVisible()
    // Escape closes — ToolbarPopover binds keydown to window.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('kitable-toolbar-sort-menu')).toHaveCount(0)

    await page.getByTestId('kitable-toolbar-group').click()
    await expect(page.getByTestId('kitable-toolbar-group-menu')).toBeVisible()
  })

  test('keeps every sort rule control inside the popover bounds', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    await page.getByTestId('kitable-toolbar-sort').click()
    const menu = page.getByTestId('kitable-toolbar-sort-menu')
    await menu.getByRole('button', { name: 'Add another sort' }).click()

    const row = menu.locator('.data-inline-sort-row').first()
    const field = row.locator('.data-inline-sort-field')
    const direction = row.locator('.data-inline-sort-direction')
    const remove = row.getByRole('button', { name: 'Remove sort' })
    await field.locator('select[aria-label="Sort field"]').selectOption('received_at')
    await direction.locator('select[aria-label="Sort direction"]').selectOption('desc')
    await expect(row).toBeVisible()
    await expect(field).toBeVisible()
    await expect(direction).toBeVisible()
    await expect(direction).toContainText('Latest → Earliest')
    await expect(remove).toBeVisible()

    const bounds = await Promise.all([
      menu.boundingBox(),
      row.boundingBox(),
      field.boundingBox(),
      direction.boundingBox(),
      remove.boundingBox(),
    ])
    const [menuBox, rowBox, fieldBox, directionBox, removeBox] = bounds
    expect(menuBox).not.toBeNull()
    expect(rowBox).not.toBeNull()
    expect(fieldBox).not.toBeNull()
    expect(directionBox).not.toBeNull()
    expect(removeBox).not.toBeNull()
    expect(rowBox!.x).toBeGreaterThanOrEqual(menuBox!.x)
    expect(removeBox!.x + removeBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width)
    expect(fieldBox!.width).toBeGreaterThan(80)
    expect(directionBox!.width).toBeGreaterThan(120)
  })

  test('search input accepts typing and the value persists in the DOM', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const searchInput = page.getByTestId('kitable-toolbar-search')
    await expect(searchInput).toHaveValue('')
    await searchInput.fill('phase 2')
    await expect(searchInput).toHaveValue('phase 2')
  })

  test('aligns the horizontal scrollbar with the left edge of the grid', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 720 })
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const gridCanvas = page.locator('.data-inline-grid-canvas')
    const horizontalScroller = gridCanvas.locator('[data-t-grid-horizontal-scroller]')
    await expect(horizontalScroller).toBeVisible()

    const [canvasBox, scrollerBox] = await Promise.all([
      gridCanvas.boundingBox(),
      horizontalScroller.boundingBox(),
    ])
    expect(canvasBox).not.toBeNull()
    expect(scrollerBox).not.toBeNull()
    expect(Math.abs(scrollerBox!.x - canvasBox!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(scrollerBox!.width - canvasBox!.width)).toBeLessThanOrEqual(1)

    const scrollRange = await horizontalScroller.evaluate((element) => ({
      maximum: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
    }))
    expect(scrollRange.maximum).toBeGreaterThan(0)
    expect(scrollRange.scrollLeft).toBe(0)
  })

  test('text cell editing uses one brand-purple focus border', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await expect(gridStage).toBeVisible()
    await gridStage.click({ position: { x: 145, y: 48 } })
    await gridStage.dblclick({ position: { x: 145, y: 48 } })

    const editor = page.locator('.data-inline-grid-canvas input.cursor-text')
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()

    const focusStyle = await editor.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
      }
    })

    expect(focusStyle).toEqual({
      borderColor: 'rgb(86, 69, 212)',
      boxShadow: 'none',
    })
  })

  test('centers grid content and copies the selected cell to the system clipboard', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const textDraws: Array<{ text: string; textAlign: CanvasTextAlign; y: number }> = []
      stateWindow.__kitionTextDraws = textDraws
      const originalFillText = CanvasRenderingContext2D.prototype.fillText
      CanvasRenderingContext2D.prototype.fillText = function fillText(
        text: string,
        x: number,
        y: number,
        maxWidth?: number,
      ) {
        textDraws.push({ text, textAlign: this.textAlign, y })
        if (maxWidth === undefined) return originalFillText.call(this, text, x, y)
        return originalFillText.call(this, text, x, y, maxWidth)
      }
    })
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    await expect.poll(() => page.evaluate(() => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const textDraws = stateWindow.__kitionTextDraws as Array<{
        text: string
        textAlign: CanvasTextAlign
        y: number
      }>
      return textDraws.some((draw) =>
        draw.text === 'Phase 2 wrap'
        && draw.textAlign === 'center'
        && Math.abs(draw.y - 52) < 0.75
      )
    })).toBe(true)

    await expect.poll(() => page.evaluate(() => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const textDraws = stateWindow.__kitionTextDraws as Array<{ text: string }>
      const raw = '2026-07-23T04:14:47Z'
      const date = new Date(raw)
      const pad = (value: number) => String(value).padStart(2, '0')
      const expected = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`

      return {
        hasFormattedDate: textDraws.some((draw) => draw.text === expected),
        hasRawTimestamp: textDraws.some((draw) => draw.text === raw),
      }
    })).toEqual({ hasFormattedDate: true, hasRawTimestamp: false })

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await gridStage.hover({ position: { x: 145, y: 48 } })
    await gridStage.click({ position: { x: 145, y: 48 } })
    await page.keyboard.press('Control+c')

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Phase 2 wrap')
  })

  test('opens date fields with compact calendar and time popovers', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await gridStage.hover({ position: { x: 545, y: 48 } })
    await gridStage.click({ position: { x: 545, y: 48 } })

    const editor = page.getByTestId('table-date-cell-editor')
    const calendar = page.getByTestId('table-date-calendar')
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('2026-07-23')
    await expect(editor).toContainText('12:14')
    await expect(calendar).toBeVisible()
    await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0)

    const calendarBox = await calendar.boundingBox()
    expect(calendarBox?.width).toBeLessThanOrEqual(290)
    expect(calendarBox?.height).toBeLessThanOrEqual(390)

    await editor.getByTestId('table-date-time-trigger').click()
    const timeMenu = page.getByTestId('table-date-time-menu')
    await expect(timeMenu).toBeVisible()
    await expect(timeMenu).toContainText('12:14')
    const timeMenuBox = await timeMenu.boundingBox()
    expect(timeMenuBox?.width).toBeLessThanOrEqual(100)
    expect(timeMenuBox?.height).toBeLessThanOrEqual(250)
  })

  test('Ctrl/Cmd+Z undoes a saved cell edit and Ctrl/Cmd+Shift+Z redoes it', async ({ page }) => {
    const patches: Array<{ values?: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH'
        && /\/api\/v1\/data-documents\/1\/tables\/11\/records\/1001$/.test(request.url())
      ) {
        patches.push(request.postDataJSON() as { values?: Record<string, unknown> })
      }
    })

    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const undoButton = page.getByTestId('kitable-toolbar-undo')
    const redoButton = page.getByTestId('kitable-toolbar-redo')
    await expect(undoButton).toBeDisabled()
    await expect(redoButton).toBeDisabled()

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await gridStage.click({ position: { x: 145, y: 48 } })
    await gridStage.dblclick({ position: { x: 145, y: 48 } })
    const editor = page.locator('.data-inline-grid-canvas input.cursor-text')
    await expect(editor).toBeFocused()
    await editor.fill('Undoable title')
    await editor.press('Enter')

    await expect.poll(() => patches.length).toBe(1)
    expect(patches[0]).toEqual({ values: { title: 'Undoable title' } })
    await expect(undoButton).toBeEnabled()
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+z')
    await expect.poll(() => patches.length).toBe(2)
    expect(patches[1]).toEqual({ values: { title: 'Phase 2 wrap' } })
    await expect(redoButton).toBeEnabled()

    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => patches.length).toBe(3)
    expect(patches[2]).toEqual({ values: { title: 'Undoable title' } })
  })

  test('keeps active table controls readable in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)
    await expect(page.locator('html')).toHaveClass(/dark/)

    const freezeButton = page.getByTestId('kitable-toolbar-freeze')
    await freezeButton.click()
    await page.getByTestId('kitable-toolbar-freeze-menu').getByRole('radio').nth(1).check()
    await expect(freezeButton).toHaveClass(/is-active/)

    const colors = await page.evaluate(() => {
      const read = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector) as HTMLElement)
        return { background: style.backgroundColor, foreground: style.color }
      }
      const rootStyle = getComputedStyle(document.documentElement)

      return {
        primary: rootStyle.getPropertyValue('--primary').trim(),
        primaryForeground: rootStyle.getPropertyValue('--primary-foreground').trim(),
        brand: rootStyle.getPropertyValue('--brand').trim(),
        brandForeground: rootStyle.getPropertyValue('--brand-foreground').trim(),
        activeView: read('.data-inline-view-tab.is-active'),
        freeze: read('[data-testid="kitable-toolbar-freeze"]'),
        addRecord: read('.data-inline-add-record-button'),
      }
    })

    expect(colors).toEqual({
      primary: '247.133 62.445% 55.098%',
      primaryForeground: '0 0% 100%',
      brand: '247.133 62.445% 55.098%',
      brandForeground: '0 0% 100%',
      activeView: {
        background: 'rgba(86, 69, 212, 0.2)',
        foreground: 'rgb(255, 255, 255)',
      },
      freeze: {
        background: 'rgba(86, 69, 212, 0.2)',
        foreground: 'rgb(255, 255, 255)',
      },
      addRecord: {
        background: 'rgb(86, 69, 212)',
        foreground: 'rgb(255, 255, 255)',
      },
    })
  })
})
