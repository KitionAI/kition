import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'

type NodeCadDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ CadDocument: { create(name: string, width: number, height: number): NodeCadDocument; open(name: string, bytes: Uint8Array): NodeCadDocument } }>('cad', 'kition_cad_sdk')

/** A real drawing made by the same engine the page runs: a room outline on its own layer. */
async function planFixture() {
  const sdk = await engine.load()
  const doc = sdk.CadDocument.create('Plan.dxf', 420, 297)
  doc.execute('layer.new', JSON.stringify({ name: 'Walls', current: true }))
  doc.execute('pline', JSON.stringify({ vertices: [[40, 40], [300, 40], [300, 220], [40, 220]], closed: true }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

async function entitiesOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.CadDocument.open('Saved.dxf', bytes)
  const count = (JSON.parse(doc.inspect()) as { entities: number }).entities
  doc.free()
  return count
}

test('opens a drawing in the CAD kit’s own editor, draws in it, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the CAD kit editor is not built into public/kits/cad-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.dxf', await planFixture())
  try {
    await expect(kit.getByTestId('cad-status')).toHaveText('1 objects', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('cad-layer-Walls')).toBeVisible()
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // A line typed on the command line.
    const line = kit.getByTestId('cad-command-line')
    for (const text of ['line', '60,60', '200,120', '']) {
      await line.fill(text)
      await line.press('Enter')
    }
    await expect(kit.getByTestId('cad-status')).toHaveText('2 objects')
    await expect(kit.getByTestId('cad-unsaved')).toBeVisible()

    // A circle drawn with the ribbon's tool on the canvas.
    await kit.getByTestId('cad-tool-circle').click()
    await expect(kit.getByTestId('cad-tool-circle')).toHaveAttribute('aria-pressed', 'true')
    const region = (await kit.getByTestId('cad-canvas-region').boundingBox())!
    await page.mouse.click(region.x + region.width * 0.7, region.y + region.height * 0.4)
    await page.mouse.click(region.x + region.width * 0.7 + 30, region.y + region.height * 0.4)
    await expect(kit.getByTestId('cad-status')).toHaveText('3 objects')
    await kit.getByTestId('cad-mode-ortho').click()
    await expect(kit.getByTestId('cad-mode-ortho')).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('cad-embedded.png') })

    await kit.getByTestId('cad-save').click()
    await expect(kit.getByTestId('cad-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Plan.dxf'])
    if (canReadBlobBodies(browserName)) expect(await entitiesOf(saves[0].bytes)).toBe(3)
  } finally {
    await host.dispose()
  }
})
