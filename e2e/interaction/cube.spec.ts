/**
 * Interaction suite: the Cube kit (`kit.cube`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @cube`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): no e2e case for this kit yet; headless-draft.spec.ts drives only kit.sheet.
 * - H13 (co-editing): covered by e2e/collab-cube.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('cube', 'CubeDocument')
const namesOf = async (bytes: Buffer) => ((await engine.inspect('Saved.kcube', bytes)).objects as Array<{ name: string }>).map((object) => object.name)
const objectsOf = async (bytes: Buffer) => (await namesOf(bytes)).length

/** The starter scene (cube, light, camera) and `spheres` spheres beside the cube. */
const room = (spheres: number) =>
  engine.make('Room.kcube', 1280, 720, (doc) => {
    for (let index = 0; index < spheres; index += 1) doc.execute('add.uvSphere', JSON.stringify({ name: `Ball ${index + 1}`, location: [3 + index * 2, 0, 1] }))
  })

/** Selects the cube in the middle of the view and duplicates it (Shift+D). */
async function duplicateCube(page: Page, kit: FrameLocator) {
  const viewport = (await kit.getByTestId('cube-viewport').boundingBox())!
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
  await page.keyboard.press('Shift+D')
  // Shift+D starts a move of the copy; a click puts it down where it is.
  await page.keyboard.press('Enter')
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('cube-status')).toContainText(new RegExp(`(^|\\D)${count} objects`), { timeout: 60_000 })

hostMatrix({
  kit: 'cube',
  createGroup: 'Visual',
  createdName: 'Untitled cube.kcube',
  file: 'Room.kcube',
  fixture: () => room(1),
  variant: () => room(3),
  measure: objectsOf,
  counts: { fixture: 4, edited: 5, variant: 6 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: duplicateCube,
})

test.describe('cube details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Cube kit is not built into public/kits/cube-ui')
    test.setTimeout(180_000)
  })

  test('an object selected in the outliner and deleted stays deleted after a save', tags('cube', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kcube', await room(1))
    try {
      await shows(kit, 4)
      await kit.getByTestId('cube-outliner-item').filter({ hasText: 'Ball 1' }).click()
      const viewport = (await kit.getByTestId('cube-viewport').boundingBox())!
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
      // X deletes, as in Blender (Delete does nothing while the outliner has the keyboard: P2 in the report).
      await page.keyboard.press('x')
      await shows(kit, 3)
      await page.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => saves.length, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await namesOf(saves.at(-1)!.bytes)).toEqual(['Cube', 'Light', 'Camera'])
    } finally {
      await host.dispose()
    }
  })

  test('orbiting and zooming the view change no object', tags('cube', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kcube', await room(1))
    try {
      await shows(kit, 4)
      const viewport = (await kit.getByTestId('cube-viewport').boundingBox())!
      const middle = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }
      await page.mouse.move(middle.x, middle.y)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(middle.x + 120, middle.y + 40, { steps: 8 })
      await page.mouse.up({ button: 'middle' })
      await page.mouse.wheel(0, -300)
      await shows(kit, 4)
      await expect(kit.getByTestId('cube-unsaved')).toHaveCount(0)
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
