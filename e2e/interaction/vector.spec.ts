/**
 * Interaction suite: the Vector kit (`kit.vector`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @vector`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): e2e/kit-bridge.spec.ts edits a drawing open in the page through the Kit AI bridge.
 * - H13 (co-editing): covered by e2e/collab-vector.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('vector', 'VectorDocument')

/** The shapes in a saved drawing, on every layer, as the status bar counts them. */
const shapesOf = async (bytes: Buffer) => ((await engine.inspect('Saved.kvector', bytes)).layers as Array<{ children: unknown[] }>).reduce((sum, layer) => sum + layer.children.length, 0)
const layersOf = async (bytes: Buffer) => ((await engine.inspect('Saved.kvector', bytes)).layers as unknown[]).length

/** A drawing with `count` rectangles side by side. */
const logo = (count: number) =>
  engine.make('Logo.kvector', 400, 300, (doc) => {
    for (let index = 0; index < count; index += 1) doc.execute('shape.rectangle', JSON.stringify({ x: 20 + index * 60, y: 40, width: 40, height: 40 }))
    doc.execute('select.none', '{}')
  })

/** Draws a rectangle with the Rectangle tool in an empty part of the canvas. */
async function drawRectangle(page: Page, kit: FrameLocator, at = 0.6) {
  await kit.getByTestId('vector-tool-rectangle').click()
  const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
  await page.mouse.move(region.x + region.width * at, region.y + region.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(region.x + region.width * at + 50, region.y + region.height * 0.6 + 40, { steps: 5 })
  await page.mouse.up()
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('vector-status')).toContainText(new RegExp(`(^|\\D)${count} objects`), { timeout: 60_000 })

hostMatrix({
  kit: 'vector',
  createGroup: 'Visual',
  createdName: 'Untitled vector.kvector',
  file: 'Logo.kvector',
  fixture: () => logo(1),
  variant: () => logo(3),
  measure: shapesOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: (page, kit) => drawRectangle(page, kit),
})

test.describe('vector details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Vector kit is not built into public/kits/vector-ui')
    test.setTimeout(180_000)
  })

  test('an ellipse from the rectangle slot’s flyout and a new layer save as drawn', tags('vector', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Logo.kvector', await logo(1))
    try {
      await shows(kit, 1)
      await kit.getByTestId('vector-tool-rectangle').click({ button: 'right' })
      await kit.getByTestId('vector-tool-ellipse').click()
      const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
      await page.mouse.move(region.x + region.width * 0.6, region.y + region.height * 0.55)
      await page.mouse.down()
      await page.mouse.move(region.x + region.width * 0.6 + 60, region.y + region.height * 0.55 + 50, { steps: 5 })
      await page.mouse.up()
      await shows(kit, 2)
      await kit.getByTestId('vector-new-layer').click()
      await expect(kit.getByTestId('vector-layers-panel').getByText('Layer 2')).toBeVisible()
      await kit.getByTestId('vector-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await shapesOf(saves.at(-1)!.bytes)).toBe(2)
      expect(await layersOf(saves.at(-1)!.bytes)).toBe(2)
    } finally {
      await host.dispose()
    }
  })

  test('select all, delete, and undo bring every shape back', tags('vector', ['H4'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Logo.kvector', await logo(3))
    try {
      await shows(kit, 3)
      // A marquee with the Selection tool (the tool a drawing opens with) over the whole canvas selects every shape.
      const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
      await page.mouse.move(region.x + 4, region.y + 4)
      await page.mouse.down()
      await page.mouse.move(region.x + region.width - 4, region.y + region.height - 4, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.press('Delete')
      const mod = (await kit.locator('body').evaluate(() => /Mac/i.test(navigator.platform))) ? 'Meta' : 'Control'
      await shows(kit, 0)
      await page.keyboard.press(`${mod}+z`)
      await shows(kit, 3)
      // Undone to the state it opened in: nothing to save.
      await expect(kit.getByTestId('vector-unsaved')).toHaveCount(0)
      await expect(kit.getByTestId('vector-save')).toBeDisabled()
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
