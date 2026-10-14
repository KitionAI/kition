import { expect, test, type Page } from '@playwright/test'

import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import {
  applyMockTableOps,
  emitTableChanged,
  FIXTURE_DOCUMENT,
  FIXTURE_RECORDS,
  freshMockTableCounters,
  mockKitableDataDocumentApi,
  mockKitableDesktopBridge,
} from './helpers/kitableApi'

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

// Groundwork for the KDM switch-over (not called by the editor yet). These
// check the mock helper itself, not the app, so they touch neither a page
// nor a route: a pure-logic check of applyMockTableOps's fidelity (the real
// coverage for the contracts in contracts/runtime/data-documents-transact.schema.json),
// and one tiny smoke test that emitTableChanged reaches the kit bridge
// stream, using a single fetch rather than its own EventSource so it cannot
// race whatever stream the editor itself opens once Task 10 wires it up.
test.describe('kitable editor — table transaction mock fidelity', () => {
  function freshState() {
    return {
      document: structuredClone(FIXTURE_DOCUMENT),
      records: FIXTURE_RECORDS.items.map((item) => ({ ...item, values: { ...item.values } })),
      counters: freshMockTableCounters(),
    }
  }

  test('rejects an empty ops array', () => {
    const { document, records, counters } = freshState()
    const result = applyMockTableOps(document, records, [], '1', 'person:session:a', counters)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('records.create honors at.before and at.after, not just append', () => {
    const { document, records, counters } = freshState()
    applyMockTableOps(
      document,
      records,
      [{ op: 'records.create', tableId: 11, at: { before: 'r_one' }, records: [{ title: 'Before r_one' }] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(records.map((record) => record.row_key)).toEqual(['e2e_0', 'r_one', 'r_two'])

    applyMockTableOps(
      document,
      records,
      [{ op: 'records.create', tableId: 11, at: { after: 'r_one' }, records: [{ title: 'After r_one' }] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(records.map((record) => record.row_key)).toEqual(['e2e_0', 'r_one', 'e2e_1', 'r_two'])
  })

  test('recomputes order per table after every op', () => {
    const { document, records, counters } = freshState()
    applyMockTableOps(
      document,
      records,
      [{ op: 'records.create', tableId: 11, at: { before: 'r_one' }, records: [{ title: 'New first row' }] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(records.map((record) => record.order)).toEqual([0, 1, 2])

    applyMockTableOps(
      document,
      records,
      [{ op: 'records.delete', tableId: 11, rowKeys: ['r_one'] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(records.map((record) => record.order)).toEqual([0, 1])
  })

  test('records.move actually reorders the records', () => {
    const { document, records, counters } = freshState()
    const result = applyMockTableOps(
      document,
      records,
      [{ op: 'records.move', tableId: 11, rowKeys: ['r_two'], before: 'r_one' }],
      '1',
      'person:session:a',
      counters,
    )
    expect(records.map((record) => record.row_key)).toEqual(['r_two', 'r_one'])
    expect(result.change.recordsReordered).toEqual([11])
  })

  test('fields.move actually reorders the table fields', () => {
    const { document, records, counters } = freshState()
    const result = applyMockTableOps(
      document,
      records,
      [{ op: 'fields.move', tableId: 11, fieldIds: [102], toIndex: 0 }],
      '1',
      'person:session:a',
      counters,
    )
    expect(document.tables[0].fields.map((field) => field.id)).toEqual([102, 101, 103])
    expect(document.tables[0].fields.map((field) => field.order)).toEqual([0, 1, 2])
    expect(result.change.schema).toEqual([11])
  })

  test('cells.set and records.delete ignore a row that belongs to a different table', () => {
    const { document, records, counters } = freshState()
    const setResult = applyMockTableOps(
      document,
      records,
      [{ op: 'cells.set', tableId: 999, records: [{ rowKey: 'r_one', values: { title: 'should not apply' } }] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(setResult.change.recordsUpserted).toEqual([])
    expect(records.find((record) => record.row_key === 'r_one')?.values.title).toBe('Phase 2 wrap')

    const deleteResult = applyMockTableOps(
      document,
      records,
      [{ op: 'records.delete', tableId: 999, rowKeys: ['r_one'] }],
      '1',
      'person:session:a',
      counters,
    )
    expect(deleteResult.change.recordsDeleted).toEqual([])
    expect(records.some((record) => record.row_key === 'r_one')).toBe(true)
  })
})

test.describe('kitable editor — table/changed bridge event', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await mockKitableDataDocumentApi(page)
    await mockKitableDesktopBridge(page)
  })

  test('emitTableChanged queues a table/changed notification for the next bridge poll', async ({ page }) => {
    await page.goto('/')
    await waitForKitableEditor(page)

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

    // A plain fetch (not an EventSource) so this never races a stream the
    // editor itself opens once Task 10 wires in useTableLiveChanges.
    const body = await page.evaluate(
      (baseUrl) => fetch(`${baseUrl}/v1/kits/bridge`).then((response) => response.text()),
      API_BASE_URL,
    )
    expect(body).toContain('"method":"table/changed"')
    expect(body).toContain('"documentId":"1"')
    expect(body).toContain('"origin":"agent:turn-1"')
  })
})
