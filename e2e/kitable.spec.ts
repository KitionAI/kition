import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { emitTableChanged, mockKitableDataDocumentApi, mockKitableDesktopBridge } from './helpers/kitableApi'

// Date editor fixtures expect local time eight hours ahead of UTC.
test.use({ timezoneId: 'Asia/Shanghai' })

// The fixture desktop bridge reports this as backend_base_url; the editor's
// own requests resolve to it, so a test's own fetches use it too.
const API_BASE_URL = 'http://127.0.0.1:18101/api'

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

  test('resizes a grid column by dragging its header boundary and saves the width', async ({ page }) => {
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await expect(gridStage).toBeVisible()
    const box = await gridStage.boundingBox()
    expect(box).not.toBeNull()

    // The fixture has three 24px row controls and starts every field at 200px.
    const expectedBoundaryX = box!.x + 72 + 200
    const headerY = box!.y + 16
    let firstColumnBoundaryX: number | null = null
    for (let delta = -12; delta <= 12; delta++) {
      const candidateX = expectedBoundaryX + delta
      await page.mouse.move(candidateX, headerY)
      const cursor = await gridStage.evaluate(async (node) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        return node.parentElement?.style.cursor
      })
      if (cursor === 'ew-resize') {
        firstColumnBoundaryX = candidateX
        break
      }
    }
    expect(firstColumnBoundaryX).not.toBeNull()

    const resizedBoundaryX = firstColumnBoundaryX! + 80
    const resizeRequestPromise = page.waitForRequest((request) => (
      request.method() === 'PATCH'
      && /\/views\/201\/view-fields\/101$/.test(new URL(request.url()).pathname)
    ))

    await page.mouse.down()
    await page.mouse.move(resizedBoundaryX, headerY, { steps: 8 })
    await page.mouse.up()

    const resizeRequest = await resizeRequestPromise
    expect(resizeRequest.postDataJSON()).toEqual({ width: 280 })

    await page.mouse.move(resizedBoundaryX, headerY)
    await expect.poll(
      () => gridStage.evaluate((node) => node.parentElement?.style.cursor),
    ).toBe('ew-resize')
  })

  test('drags a grid column and persists the reordered field positions', async ({ page }) => {
    const fieldOrderPatches: Array<{ fieldId: number; order?: number }> = []
    page.on('request', (request) => {
      const match = request.url().match(
        /\/api\/v1\/data-documents\/1\/tables\/11\/fields\/(\d+)$/,
      )
      if (request.method() !== 'PATCH' || !match) return
      fieldOrderPatches.push({
        fieldId: Number(match[1]),
        ...(request.postDataJSON() as { order?: number }),
      })
    })

    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)

    const gridStage = page.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await expect(gridStage).toBeVisible()
    const box = await gridStage.boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + 345, box!.y + 16)
    await page.mouse.down()
    await page.mouse.move(box!.x + 85, box!.y + 16, { steps: 8 })
    await page.mouse.up()

    await expect.poll(() => fieldOrderPatches).toEqual([
      { fieldId: 102, order: 0 },
      { fieldId: 101, order: 1 },
    ])
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
    const recordPatches: Array<{ values?: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH'
        && /\/api\/v1\/data-documents\/1\/tables\/11\/records\/1001$/.test(request.url())
      ) {
        recordPatches.push(request.postDataJSON() as { values?: Record<string, unknown> })
      }
    })
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

    const nextDate = await page.evaluate(() => {
      const next = new Date('2026-07-23T04:14:47Z')
      next.setDate(next.getDate() + 1)
      const pad = (value: number) => String(value).padStart(2, '0')
      return {
        key: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`,
        stored: next.toISOString(),
      }
    })
    await calendar.locator(`[data-date="${nextDate.key}"]`).click()
    await expect(calendar).toBeHidden()
    await expect.poll(() => recordPatches).toContainEqual({
      values: { received_at: nextDate.stored },
    })

    await gridStage.click({ position: { x: 545, y: 48 } })
    await expect(calendar).toBeVisible()

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
    await page.addInitScript(() => {
      localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify({
        general: { theme: 'dark' },
      }))
    })
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

// Groundwork for the KDM switch-over (not called by the editor yet): the mock
// handlers these tests exercise cover the contracts in
// contracts/runtime/data-documents-transact.schema.json and
// contracts/runtime/table-changed.schema.json.
test.describe('kitable editor — table transaction mocks', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockKitableDataDocumentApi(page)
    await mockKitableDesktopBridge(page)
    await page.goto('/')
    await waitForKitableEditor(page)
  })

  async function transact(page: Page, ops: unknown[]) {
    return page.evaluate(
      async ({ baseUrl, body }) => {
        const response = await fetch(`${baseUrl}/v1/data-documents/1/transact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return response.json()
      },
      { baseUrl: API_BASE_URL, body: { ops } },
    )
  }

  test('applies cells.set, records.create, and records.delete to the mock records', async ({ page }) => {
    const setResult = await transact(page, [
      { op: 'cells.set', tableId: 11, records: [{ rowKey: 'r_one', values: { title: 'Updated title' } }] },
    ])
    expect(setResult.data.change.recordsUpserted).toEqual([[11, 'r_one']])

    const createResult = await transact(page, [
      { op: 'records.create', tableId: 11, at: null, records: [{ title: 'New row' }] },
    ])
    expect(createResult.data.created).toHaveLength(1)
    const [newRowKey] = createResult.data.created as string[]

    const records = await page.evaluate(
      (baseUrl) => fetch(`${baseUrl}/v1/data-documents/1/tables/11/records`).then((response) => response.json()),
      API_BASE_URL,
    )
    const updated = records.data.items.find((item: { row_key: string }) => item.row_key === 'r_one')
    expect(updated.values.title).toBe('Updated title')
    expect(records.data.total).toBe(3)

    const deleteResult = await transact(page, [{ op: 'records.delete', tableId: 11, rowKeys: [newRowKey] }])
    expect(deleteResult.data.change.recordsDeleted).toEqual([[11, newRowKey]])
  })

  test('POST /undo and /redo answer done: false, and GET /history-state reports no history', async ({ page }) => {
    const fetchJson = (path: string, init?: RequestInit) => page.evaluate(
      ({ baseUrl, path: requestPath, init: requestInit }) => fetch(`${baseUrl}${requestPath}`, requestInit).then((response) => response.json()),
      { baseUrl: API_BASE_URL, path, init },
    )

    const undo = await fetchJson('/v1/data-documents/1/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(undo.data.done).toBe(false)

    const redo = await fetchJson('/v1/data-documents/1/redo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(redo.data.done).toBe(false)

    const historyState = await fetchJson('/v1/data-documents/1/history-state')
    expect(historyState.data).toEqual({ canUndo: false, canRedo: false })
  })
})

test.describe('kitable editor — table/changed bridge event', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockKitableDataDocumentApi(page)
    await mockKitableDesktopBridge(page)
  })

  test('emitTableChanged delivers a table/changed notification on the kit bridge stream', async ({ page }) => {
    await page.goto('/')
    await waitForKitableEditor(page)

    const received = page.evaluate(
      (baseUrl) => new Promise((resolve) => {
        const source = new EventSource(`${baseUrl}/v1/kits/bridge`)
        source.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.method === 'table/changed') {
            source.close()
            resolve(message.params)
          }
        }
      }),
      API_BASE_URL,
    )

    await emitTableChanged(page, {
      documentId: '1',
      origin: 'agent:turn-1',
      tables: [],
      schema: [],
      views: [],
      recordsUpserted: [[11, 'r_one']],
      recordsDeleted: [],
      recordsReordered: [],
      dashboards: false,
      documentPath: 'table-test.kitable',
    })

    const params = await received
    expect(params).toMatchObject({ documentId: '1', origin: 'agent:turn-1', recordsUpserted: [[11, 'r_one']] })
  })
})
