/**
 * Interaction suite: the Board kit (`kit.board`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @board`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10-H12 (history, print, agent) are covered by note-history, kit-print and headless-draft specs.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { coEditing } from './coediting'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('board', 'BoardDocument')
const elementsOf = async (bytes: Buffer) => (await engine.inspect('Saved.kboard', bytes)).elements as number

/** A board with `count` shapes in a row. */
const plan = (count: number) =>
  engine.make('Plan.kboard', 1920, 1080, (doc) => {
    if (count) doc.execute('element.create', JSON.stringify({ elements: Array.from({ length: count }, (_, index) => ({ kind: 'shape', position: { x: 40 + index * 200, y: 40 }, size: { w: 160, h: 100 } })) }))
  })

/** Draws a rectangle with the shape tool (`r`) in an empty part of the view. */
async function drawRectangle(page: Page, kit: FrameLocator, at = 0.6) {
  const canvas = (await kit.getByTestId('board-canvas').boundingBox())!
  await page.mouse.click(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.2)
  await page.keyboard.press('r')
  await page.mouse.move(canvas.x + canvas.width * at, canvas.y + canvas.height * 0.6)
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width * at + 160, canvas.y + canvas.height * 0.6 + 100, { steps: 8 })
  await page.mouse.up()
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('board-status')).toContainText(new RegExp(`(^|\\D)${count} elements`), { timeout: 60_000 })

hostMatrix({
  kit: 'board',
  createGroup: 'Visual',
  createdName: 'Untitled board.kboard',
  file: 'Plan.kboard',
  fixture: () => plan(1),
  variant: () => plan(3),
  measure: elementsOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: (page, kit) => drawRectangle(page, kit),
})

coEditing({
  kit: 'board',
  module: 'kition_board_sdk',
  file: 'Plan.kboard',
  title: 'Plan',
  fixture: () => plan(1),
  count: 1,
  shows,
  edit: (page, kit, slot) => drawRectangle(page, kit, 0.15 + slot * 0.18),
})

test.describe('board details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Board kit is not built into public/kits/board-ui')
    test.setTimeout(180_000)
  })

  test('a pen stroke and a text label save as drawn', tags('board', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.kboard', await plan(1))
    try {
      await shows(kit, 1)
      const canvas = (await kit.getByTestId('board-canvas').boundingBox())!
      await page.mouse.click(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.2)
      await page.keyboard.press('p')
      await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.7)
      await page.mouse.down()
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(canvas.x + canvas.width * 0.5 + step * 12, canvas.y + canvas.height * 0.7 + (step % 2) * 14)
      await page.mouse.up()
      await shows(kit, 2)
      // The Text tool: a click opens a text box there, typing fills it, Enter commits it.
      await page.keyboard.press('Escape')
      await page.keyboard.press('t')
      await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.85)
      await expect(kit.getByTestId('board-text-editor')).toBeFocused()
      await page.keyboard.type('Launch')
      await page.keyboard.press('Enter')
      await shows(kit, 3)
      await page.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await elementsOf(saves.at(-1)!.bytes)).toBe(3)
    } finally {
      await host.dispose()
    }
  })

  test('zooming and panning the view change no element', tags('board', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.kboard', await plan(2))
    try {
      await shows(kit, 2)
      const canvas = (await kit.getByTestId('board-canvas').boundingBox())!
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -400)
      await page.keyboard.up('Control')
      await page.mouse.wheel(300, 200)
      await shows(kit, 2)
      await expect(kit.getByTestId('board-unsaved')).toHaveCount(0)
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
