import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type NodeVectorDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ VectorDocument: { create(name: string, width: number, height: number): NodeVectorDocument } }>('vector', 'kition_vector_sdk')

/** A real drawing made by the same engine the page runs: one rectangle. */
async function logoFixture() {
  const sdk = await engine.load()
  const doc = sdk.VectorDocument.create('Logo.kitionvector', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 40, y: 40, width: 120, height: 80 }))
  doc.execute('select.none', '{}')
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

test('opens a drawing in the Vector kit’s own editor, draws in it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Logo.kitionvector', await logoFixture())
  try {
    await expect(kit.getByTestId('vector-status')).toContainText('1 objects', { timeout: 60_000 })
    await expect(kit.getByTestId('vector-menu-Object')).toHaveText('Object')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Draw an ellipse with the tool from the rectangle slot's flyout.
    await kit.getByTestId('vector-tool-rectangle').click({ button: 'right' })
    await kit.getByTestId('vector-tool-ellipse').click()
    await expect(kit.getByTestId('vector-tool-ellipse')).toHaveAttribute('aria-pressed', 'true')
    const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
    await page.mouse.move(region.x + region.width * 0.6, region.y + region.height * 0.55)
    await page.mouse.down()
    await page.mouse.move(region.x + region.width * 0.6 + 60, region.y + region.height * 0.55 + 50, { steps: 5 })
    await page.mouse.up()
    await expect(kit.getByTestId('vector-status')).toContainText('2 objects')
    await expect(kit.getByTestId('vector-unsaved')).toBeVisible()

    // A new layer from the Layers panel.
    await kit.getByTestId('vector-new-layer').click()
    await expect(kit.getByTestId('vector-layers-panel').getByText('Layer 2')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('vector-embedded.png') })

    await kit.getByTestId('vector-save').click()
    await expect(kit.getByTestId('vector-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Logo.kitionvector'])
  } finally {
    await host.dispose()
  }
})
