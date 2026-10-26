import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'

/**
 * Kition's 3D scenes are `.kscene` files the Scene kit (`kit.scene`, KitionAI/kition-scene) edits
 * in its own editor (KitFrame). This covers what Kition adds around the kit: opening a scene from
 * the tree, editing it, saving through Kition's file API, and the create menu making a new scene
 * with the kit's engine in the page. The editor's own behavior is tested in the kit's repository.
 */

type NodeSceneDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ SceneDocument: { create(name: string, width: number, height: number): NodeSceneDocument; open(name: string, bytes: Uint8Array): NodeSceneDocument } }>('scene', 'kition_scene_sdk')
const missing = 'the Scene kit is not built into public/kits/scene-ui (scripts/fetch-kits.mjs or scripts/build-kit-ui.sh scene)'

/** A scene made by the engine the page runs: the starter scene and a sphere beside the cube. */
async function roomFixture() {
  const sdk = await engine.load()
  const doc = sdk.SceneDocument.create('Room.kscene', 1280, 720)
  doc.execute('add.uvSphere', JSON.stringify({ name: 'Ball', location: [3, 0, 1] }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The object names of a saved scene, as the engine reads it. */
async function objectsOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.SceneDocument.open('Saved.kscene', bytes)
  const names = (JSON.parse(doc.inspect()) as { objects: Array<{ name: string }> }).objects.map((object) => object.name)
  doc.free()
  return names
}

test('opens a scene in the Scene kit’s own editor, edits it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kscene', await roomFixture())
  try {
    await expect(kit.getByTestId('scene-status')).toContainText('4 objects', { timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)
    await expect(kit.getByTestId('scene-outliner-item').filter({ hasText: 'Ball' })).toBeVisible()

    // Select the cube in the middle of the view and duplicate it.
    const viewport = (await kit.getByTestId('scene-viewport').boundingBox())!
    await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
    await page.keyboard.press('Shift+D')
    await expect(kit.getByTestId('scene-status')).toContainText('5 objects')
    await page.screenshot({ path: testInfo.outputPath('scene-embedded.png') })

    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['Room.kscene'])
    expect(await objectsOf(saves[0]!.bytes)).toEqual(['Cube', 'Light', 'Camera', 'Ball', 'Cube.001'])
  } finally {
    await host.dispose()
  }
})

test('makes a new scene with the Scene kit’s engine from the create menu and opens it in the kit', async ({ page, baseURL }) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('group', { name: 'Visual' }).getByTestId('workspace-create-scene').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled scene.kscene'])
    expect(await objectsOf(saves[0]!.bytes)).toEqual(['Cube', 'Light', 'Camera'])
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('scene-status')).toContainText('3 objects', { timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})
