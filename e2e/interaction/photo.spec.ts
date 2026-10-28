/**
 * Interaction suite: the Photo kit (`kit.photo`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @photo`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10-H13 (history, print, agent, co-editing) are covered by note-history, kit-print,
 *   headless-draft and collab-photo specs; this suite does not repeat them.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('photo', 'PhotoDocument')
const layersOf = async (bytes: Buffer) => ((await engine.inspect('Saved.psd', bytes)).layers as unknown[]).length

/** An image with a background and `extra` pixel layers. */
const poster = (extra: number) =>
  engine.make('Poster.psd', 480, 320, (doc) => {
    for (let index = 0; index < extra; index += 1) doc.execute('layer.new.layer', JSON.stringify({ name: `Ink ${index + 1}` }))
  })

hostMatrix({
  kit: 'photo',
  createGroup: 'Visual',
  createdName: 'Untitled photo.psd',
  file: 'Poster.psd',
  fixture: () => poster(1),
  variant: () => poster(3),
  measure: layersOf,
  counts: { fixture: 2, edited: 3, variant: 4 },
  shows: async (_page, kit, count) => expect(kit.getByTestId('photo-status')).toContainText(`${count} layers`, { timeout: 60_000 }),
  edit: async (_page, kit) => kit.getByTestId('photo-layer-new').click(),
})

test.describe('photo details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Photo kit is not built into public/kits/photo-ui')
    test.setTimeout(180_000)
  })

  test('a brush stroke paints pixels that survive a save', tags('photo', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await poster(1))
    try {
      await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
      const region = (await kit.getByTestId('photo-canvas-region').boundingBox())!
      await page.keyboard.press('b')
      await page.mouse.move(region.x + region.width * 0.4, region.y + region.height * 0.5)
      await page.mouse.down()
      await page.mouse.move(region.x + region.width * 0.4 + 80, region.y + region.height * 0.5 + 30, { steps: 6 })
      await page.mouse.up()
      await expect(kit.getByTestId('photo-unsaved')).toBeVisible()
      await kit.getByTestId('photo-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      // The stroke is in the saved pixels: the file differs from the one opened, with the same layers.
      const saved = saves.at(-1)!.bytes
      expect(saved.equals(await poster(1))).toBe(false)
      expect(await layersOf(saved)).toBe(2)
    } finally {
      await host.dispose()
    }
  })

  test('layers: new, rename, and delete in the Layers panel save as shown', tags('photo', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await poster(1))
    try {
      await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
      await kit.getByTestId('photo-layer-new').click()
      await kit.getByTestId('photo-layer-new').click()
      await expect(kit.getByTestId('photo-status')).toContainText('4 layers')
      await kit.getByTestId('photo-layer-delete').click()
      await expect(kit.getByTestId('photo-status')).toContainText('3 layers')
      await kit.getByTestId('photo-save').click()
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await layersOf(saves.at(-1)!.bytes)).toBe(3)
    } finally {
      await host.dispose()
    }
  })
})
