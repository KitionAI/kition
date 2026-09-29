import { expect, test } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

for (const change of ['width', 'height', 'pixelRatio', 'firstVisibleDraw'] as const) {
  test(`keeps cell content visible after ${change} changes`, async ({ page }) => {
    await mockLocalWorkspaceApi(page)
    await page.goto('/')
    const pixels = await page.evaluate(async (change) => {
      const base = '/src/features/table/grid/'
      const { drawGrid } = await import(/* @vite-ignore */ `${base}renderers/layout-renderer/layoutRenderer.ts`)
      const { CoordinateManager, CombinedSelection } = await import(/* @vite-ignore */ `${base}managers/index.ts`)
      const { lightGridTheme, DEFAULT_MOUSE_STATE, DEFAULT_SCROLL_STATE } = await import(/* @vite-ignore */ `${base}configs/index.ts`)
      const { CellType, LinearRowType } = await import(/* @vite-ignore */ `${base}interface.ts`)
      const canvas = document.createElement('canvas')
      const cache = document.createElement('canvas')
      const coord = new CoordinateManager({
        rowHeight: 56, columnWidth: 200, rowCount: 1, pureRowCount: 1, columnCount: 1,
        containerWidth: 300, containerHeight: 150, rowInitSize: 32, columnInitSize: 40,
        freezeColumnCount: 1,
      })
      const props = {
        theme: lightGridTheme, width: 300, height: 150,
        columns: [{ id: 'file', name: 'File Name', width: 200 }],
        coordInstance: coord, scrollState: DEFAULT_SCROLL_STATE,
        mouseState: DEFAULT_MOUSE_STATE, selection: new CombinedSelection(),
        rowControls: [], rowIndexVisible: true,
        visibleRegion: { startRowIndex: 0, stopRowIndex: 0, startColumnIndex: 0, stopColumnIndex: 0 },
        getLinearRow: (index: number) => ({ type: LinearRowType.Row, realIndex: index, displayIndex: index + 1 }),
        real2RowIndex: (index: number) => index,
        getCellContent: () => ({ type: CellType.Text, data: 'Receipt sample', displayData: 'Receipt sample' }),
        spriteManager: { drawSprite: () => {} }, imageManager: { setWindow: () => {} },
        columnResizeState: { columnIndex: -1 }, columnFreezeState: { isFreezing: false },
        dragState: { isDragging: false },
      }
      const countTextPixels = () => {
        const ratio = Math.ceil(window.devicePixelRatio)
        const data = cache.getContext('2d')!.getImageData(42 * ratio, 34 * ratio, 190 * ratio, 50 * ratio).data
        let count = 0
        for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count++
        return count
      }
      if (change === 'firstVisibleDraw') coord.containerWidth = 0
      drawGrid(canvas, cache, props)
      const before = change === 'firstVisibleDraw' ? null : countTextPixels()
      const next = { ...props }
      if (change === 'width') { coord.containerWidth++; next.width++ }
      if (change === 'height') { coord.containerHeight++; next.height++ }
      if (change === 'pixelRatio') Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
      if (change === 'firstVisibleDraw') coord.containerWidth = 300
      drawGrid(canvas, cache, next, props)
      return { before, after: countTextPixels() }
    }, change)
    if (pixels.before !== null) expect(pixels.before).toBeGreaterThan(0)
    expect(pixels.after).toBeGreaterThan(0)
  })
}
