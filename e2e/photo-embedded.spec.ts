import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type NodePhotoDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ PhotoDocument: { create(name: string, width: number, height: number): NodePhotoDocument } }>('photo', 'kition_photo_sdk')

/** A real image made by the same engine the page runs: a background and one pixel layer. */
async function posterFixture() {
  const sdk = await engine.load()
  const doc = sdk.PhotoDocument.create('Poster.psd', 480, 320)
  doc.execute('layer.new.layer', JSON.stringify({ name: 'Ink' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

test('opens an image in the Photo kit’s own editor, paints in it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await posterFixture())
  try {
    await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    await expect(kit.getByTestId('photo-menu-Image')).toHaveText('Image')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // A brush stroke on the canvas, then a new layer from the Layers panel.
    const region = (await kit.getByTestId('photo-canvas-region').boundingBox())!
    await page.mouse.move(region.x + region.width * 0.4, region.y + region.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(region.x + region.width * 0.4 + 80, region.y + region.height * 0.5 + 30, { steps: 6 })
    await page.mouse.up()
    await expect(kit.getByTestId('photo-unsaved')).toBeVisible()
    await kit.getByTestId('photo-layer-new').click()
    await expect(kit.getByTestId('photo-status')).toContainText('3 layers')
    await page.screenshot({ path: testInfo.outputPath('photo-embedded.png') })

    await kit.getByTestId('photo-save').click()
    await expect(kit.getByTestId('photo-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Poster.psd'])
  } finally {
    await host.dispose()
  }
})
