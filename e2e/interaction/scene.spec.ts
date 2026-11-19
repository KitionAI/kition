/**
 * Interaction suite: the Scene kit (`kit.scene`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @scene`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): no e2e case for this kit yet; headless-draft.spec.ts drives only kit.sheet.
 * - H13 (co-editing): covered by e2e/collab-scene.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, nodeEngine } from './helpers-b'
import { tags } from './support'

const engine = nodeEngine('scene', 'SceneDocument')
const namesOf = async (bytes: Buffer) => ((await engine.inspect('Saved.kscene', bytes)).objects as Array<{ name: string }>).map((object) => object.name)
const objectsOf = async (bytes: Buffer) => (await namesOf(bytes)).length

/** The starter scene (cube, light, camera) and `spheres` spheres beside the cube. */
const room = (spheres: number) =>
  engine.make('Room.kscene', 1280, 720, (doc) => {
    for (let index = 0; index < spheres; index += 1) doc.execute('add.uvSphere', JSON.stringify({ name: `Ball ${index + 1}`, location: [3 + index * 2, 0, 1] }))
  })

/**
 * Selects the cube in the middle of the view and duplicates it (Shift+D). The cube is in the middle
 * once the viewport is ready (the document is the viewport's size and its picture shows); until
 * then the viewport takes no clicks (kition-scene regressions/issue-early-viewport-input), and a
 * click there would leave the document's own selection to Shift+D.
 */
async function duplicateCube(page: Page, kit: FrameLocator) {
  await expect(kit.getByTestId('scene-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  const viewport = (await kit.getByTestId('scene-viewport').boundingBox())!
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
  await expect(kit.locator('[data-testid="scene-outliner-item"][data-name="Cube"]')).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('Shift+D')
  // Shift+D starts a move of the copy; a click puts it down where it is.
  await page.keyboard.press('Enter')
}

const shows = (kit: FrameLocator, count: number) => expect(kit.getByTestId('scene-status')).toContainText(new RegExp(`(^|\\D)${count} objects`), { timeout: 60_000 })

hostMatrix({
  kit: 'scene',
  createGroup: 'Visual',
  createdName: 'Untitled scene.kscene',
  file: 'Room.kscene',
  fixture: () => room(1),
  variant: () => room(3),
  measure: objectsOf,
  counts: { fixture: 4, edited: 5, variant: 6 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: duplicateCube,
  // H16: the 3D viewport's background is the editor's, not the scene's (the world shows only in the
  // rendered view), so it follows the scheme, as Blender's theme draws it.
  dark: { surface: 'dark', area: (kit) => kit.getByTestId('scene-canvas') },
})

test.describe('scene details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Scene kit is not built into public/kits/scene-ui')
    test.setTimeout(180_000)
  })

  test('an object selected in the outliner and deleted stays deleted after a save', tags('scene', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kscene', await room(1))
    try {
      await shows(kit, 4)
      await kit.getByTestId('scene-outliner-item').filter({ hasText: 'Ball 1' }).click()
      const viewport = (await kit.getByTestId('scene-viewport').boundingBox())!
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

  test('orbiting and zooming the view change no object', tags('scene', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kscene', await room(1))
    try {
      await shows(kit, 4)
      const viewport = (await kit.getByTestId('scene-viewport').boundingBox())!
      const middle = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }
      await page.mouse.move(middle.x, middle.y)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(middle.x + 120, middle.y + 40, { steps: 8 })
      await page.mouse.up({ button: 'middle' })
      await page.mouse.wheel(0, -300)
      await shows(kit, 4)
      await expect(kit.getByTestId('scene-unsaved')).toHaveCount(0)
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
