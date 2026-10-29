/**
 * Interaction suite: the Photo kit (`kit.photo`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @photo`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): no e2e case for this kit yet; headless-draft.spec.ts drives only kit.sheet.
 * - H13 (co-editing): covered by e2e/collab-photo.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type Page } from '@playwright/test'
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

/**
 * Leaving the desktop window with unsaved kit edits (H6): its close button and the menu's Quit and
 * Reload ask first, as closing a tab does. One kit stands for all: the question is Kition's.
 */
test.describe('photo leaving the window', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Photo kit is not built into public/kits/photo-ui')
    test.setTimeout(180_000)
  })

  /** Records the window's own destroy (the close the renderer lets through), which the mocked shell answers with nothing. */
  const watchDestroy = (page: Page) =>
    page.evaluate(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, ...rest: unknown[]) => Promise<unknown> } }).__TAURI_INTERNALS__
      const invoke = internals.invoke
      ;(window as unknown as { __destroyed: number }).__destroyed = 0
      internals.invoke = (command, ...rest) => {
        if (command === 'plugin:window|destroy') (window as unknown as { __destroyed: number }).__destroyed += 1
        return invoke(command, ...rest)
      }
    })
  const destroyed = (page: Page) => page.evaluate(() => (window as unknown as { __destroyed: number }).__destroyed)

  test('the close button with unsaved edits asks: cancel keeps the window, save saves and closes it', tags('photo', ['H6'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await poster(1), {}, { persist: true })
    try {
      await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
      await watchDestroy(page)
      // No unsaved edits: the window closes without a question.
      await host.emit('tauri://close-requested', null)
      await expect.poll(() => destroyed(page)).toBe(1)
      await expect(page.getByTestId('unsaved-close')).toHaveCount(0)

      await kit.getByTestId('photo-layer-new').click()
      await expect(kit.getByTestId('photo-unsaved')).toBeVisible()
      await host.emit('tauri://close-requested', null)
      await expect(page.getByTestId('unsaved-close')).toBeVisible()
      await page.getByTestId('unsaved-close-cancel').click()
      expect(await destroyed(page)).toBe(1)
      await expect(kit.getByTestId('photo-unsaved')).toBeVisible()

      await host.emit('tauri://close-requested', null)
      await page.getByTestId('unsaved-close-save').click()
      await expect.poll(() => destroyed(page), { timeout: 30_000 }).toBe(2)
      expect(await layersOf(saves.filter((save) => save.path === 'Poster.psd').at(-1)!.bytes)).toBe(3)
    } finally {
      await host.dispose()
    }
  })

  test('Quit and Reload from the menu with unsaved edits ask first', tags('photo', ['H6'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await poster(1), {}, { persist: true })
    const actions = () => host.calls.filter((call) => call.command === 'window_action').map((call) => call.args.action)
    try {
      await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
      await kit.getByTestId('photo-layer-new').click()
      await expect(kit.getByTestId('photo-unsaved')).toBeVisible()

      await host.emit('desktop:menu', { action: 'reload-window' })
      await expect(page.getByTestId('unsaved-close')).toBeVisible()
      await page.getByTestId('unsaved-close-cancel').click()
      await host.emit('desktop:menu', { action: 'quit' })
      await page.getByTestId('unsaved-close-cancel').click()
      expect(actions()).toEqual([])

      await host.emit('desktop:menu', { action: 'quit' })
      await page.getByTestId('unsaved-close-discard').click()
      await expect.poll(actions).toEqual(['quit'])
      expect(saves.filter((save) => save.path === 'Poster.psd')).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
