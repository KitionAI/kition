/**
 * Interaction suite: the Motion kit (`kit.motion`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @motion`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): no e2e case for this kit yet; headless-draft.spec.ts drives only kit.sheet.
 * - H13 (co-editing): covered by e2e/collab-motion.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 * The kit's render regressions run in `pnpm test:motion`.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { canReadBlobBodies } from '../helpers/requestBody'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('motion', 'MotionDocument')
const layersOf = async (bytes: Buffer) => ((await engine.inspect('Saved.kmotion', bytes)).info.layers as unknown[]).length

/** A 2-second composition with `solids` solids, the first fading in. */
const intro = (solids: number) =>
  engine.make('Intro.kmotion', 640, 360, (doc) => {
    doc.execute('comp.settings', JSON.stringify({ duration: 2 }))
    for (let index = 0; index < solids; index += 1) doc.execute('layer.newSolid', JSON.stringify({ name: `Solid ${index + 1}`, color: '#ff0000' }))
    const layer = (JSON.parse(doc.inspect()) as { info: { layers: Array<{ id: number }> } }).info.layers[0]?.id
    if (layer !== undefined) {
      doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 0, value: 0 }))
      doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 1, value: 100 }))
    }
    doc.execute('layer.select', JSON.stringify({ layers: [] }))
  })

/** A new text layer from the transport's New Layer menu. */
async function newText(_page: Page, kit: FrameLocator) {
  await kit.getByTestId('motion-new-layer').click()
  await kit.getByTestId('motion-new-text').click()
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('motion-status')).toContainText(new RegExp(`(^|\\D)${count} layers`), { timeout: 60_000 })

hostMatrix({
  kit: 'motion',
  createGroup: 'Media',
  createdName: 'Untitled motion.kmotion',
  file: 'Intro.kmotion',
  fixture: () => intro(1),
  variant: () => intro(3),
  measure: layersOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: newText,
})

test.describe('motion details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Motion kit is not built into public/kits/motion-ui')
    test.setTimeout(240_000)
  })

  test('scrubbing the ruler moves the time, and a render writes an MP4 beside the project', tags('motion', ['H11'], true), async ({ page, baseURL, browserName }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.kmotion', await intro(1))
    try {
      await shows(kit, 1)
      const ruler = (await kit.getByTestId('motion-ruler').boundingBox())!
      await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2)
      await expect(kit.getByTestId('motion-timecode')).not.toHaveText('0:00:00:00')
      await kit.getByTestId('motion-render').click()
      await expect.poll(() => saves.map((save) => save.path), { timeout: 180_000 }).toContain('Intro.mp4')
      if (canReadBlobBodies(browserName)) expect(saves.find((save) => save.path === 'Intro.mp4')!.bytes.subarray(4, 8).toString()).toBe('ftyp')
      // Scrubbing and rendering are not edits.
      await expect(kit.getByTestId('motion-unsaved')).toHaveCount(0)
    } finally {
      await host.dispose()
    }
  })

  test('two new layers, one undone, save as one more layer', tags('motion', ['H4'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.kmotion', await intro(1))
    try {
      await shows(kit, 1)
      await newText(page, kit)
      await newText(page, kit)
      await shows(kit, 3)
      await kit.getByTestId('motion-undo').click()
      await shows(kit, 2)
      await kit.getByTestId('motion-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await layersOf(saves.at(-1)!.bytes)).toBe(2)
    } finally {
      await host.dispose()
    }
  })
})
