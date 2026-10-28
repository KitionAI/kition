/**
 * Interaction suite: the CAD kit (`kit.cad`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @cad`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10-H13 (history, print, agent, co-editing) are covered by note-history, kit-print,
 *   headless-draft and collab-cad specs; this suite does not repeat them.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('cad', 'CadDocument')
const entitiesOf = async (bytes: Buffer) => (await engine.inspect('Saved.dxf', bytes)).entities as number

/** A drawing with a room outline on its own layer and `lines` more lines. */
const plan = (lines: number) =>
  engine.make('Plan.dxf', 420, 297, (doc) => {
    doc.execute('layer.new', JSON.stringify({ name: 'Walls', current: true }))
    doc.execute('pline', JSON.stringify({ vertices: [[40, 40], [300, 40], [300, 220], [40, 220]], closed: true }))
    for (let index = 0; index < lines; index += 1) doc.execute('line', JSON.stringify({ points: [[60, 60 + index * 10], [200, 60 + index * 10]] }))
  })

/** Types a command and its points on the command line, as a drafter would. */
async function typeCommand(kit: FrameLocator, entries: string[]) {
  const line = kit.getByTestId('cad-command-line')
  for (const text of entries) {
    await line.fill(text)
    await line.press('Enter')
  }
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('cad-status')).toHaveText(`${count} objects`, { timeout: 60_000 })
const drawLine = (_page: Page, kit: FrameLocator) => typeCommand(kit, ['line', '60,60', '200,120', ''])

hostMatrix({
  kit: 'cad',
  createGroup: 'Visual',
  createdName: 'Untitled CAD.dxf',
  file: 'Plan.dxf',
  fixture: () => plan(0),
  variant: () => plan(2),
  measure: entitiesOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: drawLine,
  modes: { 'kit.cad': 'classic' },
  viewport: { width: 1920, height: 1000 },
  // The command line keeps the keyboard after a typed command, and kit-editor reads no shortcut
  // from a field (Cmd+S there does nothing: P1 in the suite's report); a click on the drawing
  // gives the keys back to it.
  focusForKeys: async (page, kit) => {
    const region = (await kit.getByTestId('cad-canvas-region').boundingBox())!
    await page.mouse.click(region.x + region.width - 20, region.y + 20)
  },
})

test.describe('cad details', () => {
  test.use({ viewport: { width: 1920, height: 1000 } })
  test.beforeEach(() => {
    test.skip(!engine.built, 'the CAD kit is not built into public/kits/cad-ui')
    test.setTimeout(180_000)
  })

  test('a circle from the ribbon and a line from the command line save as drawn, on the current layer', tags('cad', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.dxf', await plan(0), {}, { modes: { 'kit.cad': 'classic' } })
    try {
      await shows(kit, 1)
      await expect(kit.getByTestId('cad-layer-Walls')).toBeVisible()
      await drawLine(page, kit)
      await shows(kit, 2)
      await kit.getByTestId('cad-tool-circle').click()
      const region = (await kit.getByTestId('cad-canvas-region').boundingBox())!
      await page.mouse.click(region.x + region.width * 0.7, region.y + region.height * 0.4)
      await page.mouse.click(region.x + region.width * 0.7 + 30, region.y + region.height * 0.4)
      await shows(kit, 3)
      await kit.getByTestId('cad-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await entitiesOf(saves.at(-1)!.bytes)).toBe(3)
    } finally {
      await host.dispose()
    }
  })

  test('a command cancelled with Escape draws nothing', tags('cad', ['H4']), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Plan.dxf', await plan(0), {}, { modes: { 'kit.cad': 'classic' } })
    try {
      await shows(kit, 1)
      const line = kit.getByTestId('cad-command-line')
      await line.fill('line')
      await line.press('Enter')
      await line.fill('60,60')
      await line.press('Enter')
      await line.press('Escape')
      await shows(kit, 1)
      await expect(kit.getByTestId('cad-unsaved')).toHaveCount(0)
    } finally {
      await host.dispose()
    }
  })

  test('zooming the drawing with the wheel changes no object', tags('cad', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.dxf', await plan(1), {}, { modes: { 'kit.cad': 'classic' } })
    try {
      await shows(kit, 2)
      const region = (await kit.getByTestId('cad-canvas-region').boundingBox())!
      await page.mouse.move(region.x + region.width / 2, region.y + region.height / 2)
      await page.mouse.wheel(0, -500)
      await page.mouse.wheel(0, 800)
      await shows(kit, 2)
      await expect(kit.getByTestId('cad-unsaved')).toHaveCount(0)
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
