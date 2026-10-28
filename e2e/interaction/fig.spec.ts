/**
 * Interaction suite: the Fig kit (`kit.fig`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @fig`.
 *
 * The Fig editor draws its layers on a canvas, so the suite reads the live document through
 * Kition's development hook (`liveDocument`, the Kit AI bridge's `inspect`), and its unsaved mark
 * is the Save button being enabled (Fig shows no status bar).
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10-H12 (history, print, agent) are covered by note-history, kit-print and headless-draft specs.
 * - H13 (co-editing): covered by e2e/collab-fig.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, liveDocument, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('fig', 'FigDocument')
const layersOf = async (bytes: Buffer) => (await engine.inspect('Saved.kfig', bytes)).layers as number

/** The starter frame and `count` rectangles. */
const screen = (count: number) =>
  engine.make('Screen.kfig', 1440, 1024, (doc) => {
    for (let index = 0; index < count; index += 1) doc.execute('shape.rectangle', JSON.stringify({ x: 120 + index * 360, y: 120, width: 320, height: 200 }))
  })

/** Draws a rectangle with the toolbar's shape tool in the middle of the canvas. */
async function drawRectangle(page: Page, kit: FrameLocator) {
  await kit.getByTestId('fig-caret-shape').click()
  await kit.getByTestId('fig-flyout-tool-rectangle').click()
  const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
  const from = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
  await page.mouse.move(from.x + 80, from.y + 60, { steps: 6 })
  await page.mouse.up()
}

const shows = async (page: Page, kit: FrameLocator, count: number, name: string) => {
  await expect(kit.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => ((await liveDocument(page, name))?.details as { layers?: number } | undefined)?.layers ?? null, { timeout: 60_000 }).toBe(count)
}

hostMatrix({
  kit: 'fig',
  createGroup: 'Visual',
  createdName: 'Untitled fig.kfig',
  file: 'Screen.kfig',
  fixture: () => screen(1),
  variant: () => screen(3),
  measure: layersOf,
  counts: { fixture: 2, edited: 3, variant: 4 },
  shows,
  edit: drawRectangle,
  unsaved: (kit) => kit.locator('[data-testid="fig-save"]:not([disabled])'),
})

test.describe('fig details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Fig kit is not built into public/kits/fig-ui')
    test.setTimeout(180_000)
  })

  test('a new page from the Pages panel saves with the design', tags('fig', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kfig', await screen(1))
    try {
      await shows(page, kit, 2, 'Screen.kfig')
      await kit.getByTestId('fig-pages-add').click()
      await expect.poll(async () => (((await liveDocument(page, 'Screen.kfig'))?.details as { pages?: unknown[] } | undefined)?.pages ?? []).length).toBe(2)
      await page.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(((await engine.inspect('Saved.kfig', saves.at(-1)!.bytes)).pages as unknown[]).length).toBe(2)
    } finally {
      await host.dispose()
    }
  })

  test('zooming from the zoom menu changes no layer and leaves nothing to save', tags('fig', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kfig', await screen(1))
    try {
      await shows(page, kit, 2, 'Screen.kfig')
      const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -300)
      await page.keyboard.up('Control')
      await page.mouse.wheel(200, 100)
      await shows(page, kit, 2, 'Screen.kfig')
      await expect(kit.getByTestId('fig-save')).toBeDisabled()
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
