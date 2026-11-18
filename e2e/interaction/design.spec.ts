/**
 * Interaction suite: the Design kit (`kit.design`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @design`.
 *
 * The Design editor draws its layers on a canvas, so the suite reads the live document through
 * Kition's development hook (`liveDocument`, the Kit AI bridge's `inspect`), and its unsaved mark
 * is the Save button being enabled (Design shows no status bar).
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): e2e/collab-design.spec.ts reads and edits the open design through the Kit AI bridge.
 * - H13 (co-editing): covered by e2e/collab-design.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, liveDocument, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('design', 'DesignDocument')
const layersOf = async (bytes: Buffer) => (await engine.inspect('Saved.kdesign', bytes)).layers as number

/** The starter frame and `count` rectangles. */
const screen = (count: number) =>
  engine.make('Screen.kdesign', 1440, 1024, (doc) => {
    for (let index = 0; index < count; index += 1) doc.execute('shape.rectangle', JSON.stringify({ x: 120 + index * 360, y: 120, width: 320, height: 200 }))
  })

/** Draws a rectangle with the toolbar's shape tool in the middle of the canvas. */
async function drawRectangle(page: Page, kit: FrameLocator) {
  await kit.getByTestId('design-caret-shape').click()
  await kit.getByTestId('design-flyout-tool-rectangle').click()
  const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
  const from = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
  await page.mouse.move(from.x + 80, from.y + 60, { steps: 6 })
  await page.mouse.up()
}

const shows = async (page: Page, kit: FrameLocator, count: number, name: string) => {
  await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => ((await liveDocument(page, name))?.details as { layers?: number } | undefined)?.layers ?? null, { timeout: 60_000 }).toBe(count)
}

hostMatrix({
  kit: 'design',
  createGroup: 'Visual',
  createdName: 'Untitled design.kdesign',
  file: 'Screen.kdesign',
  fixture: () => screen(1),
  variant: () => screen(3),
  measure: layersOf,
  counts: { fixture: 2, edited: 3, variant: 4 },
  shows,
  edit: drawRectangle,
  unsaved: (kit) => kit.locator('[data-testid="design-save"]:not([disabled])'),
})

test.describe('design details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Design kit is not built into public/kits/design-ui')
    test.setTimeout(180_000)
  })

  test('a new page from the Pages panel saves with the design', tags('design', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kdesign', await screen(1))
    try {
      await shows(page, kit, 2, 'Screen.kdesign')
      await kit.getByTestId('design-pages-add').click()
      await expect.poll(async () => (((await liveDocument(page, 'Screen.kdesign'))?.details as { pages?: unknown[] } | undefined)?.pages ?? []).length).toBe(2)
      await page.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(((await engine.inspect('Saved.kdesign', saves.at(-1)!.bytes)).pages as unknown[]).length).toBe(2)
    } finally {
      await host.dispose()
    }
  })

  test('zooming from the zoom menu changes no layer and leaves nothing to save', tags('design', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kdesign', await screen(1))
    try {
      await shows(page, kit, 2, 'Screen.kdesign')
      const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -300)
      await page.keyboard.up('Control')
      await page.mouse.wheel(200, 100)
      await shows(page, kit, 2, 'Screen.kdesign')
      await expect(kit.getByTestId('design-save')).toBeDisabled()
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
