/**
 * Interaction suite: the Effect kit (`kit.effect`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @effect`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10-H13 (history, print, agent, co-editing) are covered by note-history, kit-print,
 *   headless-draft and collab-effect specs; this suite does not repeat them.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 * The kit's render regressions run in `pnpm test:effect`.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { canReadBlobBodies } from '../helpers/requestBody'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('effect', 'EffectDocument')
const layersOf = async (bytes: Buffer) => ((await engine.inspect('Saved.keffect', bytes)).info.layers as unknown[]).length

/** A 2-second composition with `solids` solids, the first fading in. */
const intro = (solids: number) =>
  engine.make('Intro.keffect', 640, 360, (doc) => {
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
  await kit.getByTestId('effect-new-layer').click()
  await kit.getByTestId('effect-new-text').click()
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('effect-status')).toContainText(new RegExp(`(^|\\D)${count} layers`), { timeout: 60_000 })

hostMatrix({
  kit: 'effect',
  createGroup: 'Media',
  createdName: 'Untitled effect.keffect',
  file: 'Intro.keffect',
  fixture: () => intro(1),
  variant: () => intro(3),
  measure: layersOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: newText,
})

test.describe('effect details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Effect kit is not built into public/kits/effect-ui')
    test.setTimeout(240_000)
  })

  test('scrubbing the ruler moves the time, and a render writes an MP4 beside the project', tags('effect', ['H11'], true), async ({ page, baseURL, browserName }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.keffect', await intro(1))
    try {
      await shows(kit, 1)
      const ruler = (await kit.getByTestId('effect-ruler').boundingBox())!
      await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2)
      await expect(kit.getByTestId('effect-timecode')).not.toHaveText('0:00:00:00')
      await kit.getByTestId('effect-render').click()
      await expect.poll(() => saves.map((save) => save.path), { timeout: 180_000 }).toContain('Intro.mp4')
      if (canReadBlobBodies(browserName)) expect(saves.find((save) => save.path === 'Intro.mp4')!.bytes.subarray(4, 8).toString()).toBe('ftyp')
      // Scrubbing and rendering are not edits.
      await expect(kit.getByTestId('effect-unsaved')).toHaveCount(0)
    } finally {
      await host.dispose()
    }
  })

  test('two new layers, one undone, save as one more layer', tags('effect', ['H4'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.keffect', await intro(1))
    try {
      await shows(kit, 1)
      await newText(page, kit)
      await newText(page, kit)
      await shows(kit, 3)
      await kit.getByTestId('effect-undo').click()
      await shows(kit, 2)
      await kit.getByTestId('effect-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await layersOf(saves.at(-1)!.bytes)).toBe(2)
    } finally {
      await host.dispose()
    }
  })
})
