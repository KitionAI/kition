import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'

type NodeEffectDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ EffectDocument: { create(name: string, width: number, height: number): NodeEffectDocument } }>('effect', 'kition_effect_sdk')

/** A real project made by the same engine the page runs: a 2-second composition with a fading solid. */
async function introFixture() {
  const sdk = await engine.load()
  const doc = sdk.EffectDocument.create('Intro.ecproj', 640, 360)
  doc.execute('comp.settings', JSON.stringify({ duration: 2 }))
  doc.execute('layer.newSolid', JSON.stringify({ name: 'Red', color: '#ff0000' }))
  const layer = (JSON.parse(doc.inspect()) as { info: { layers: Array<{ id: number }> } }).info.layers[0].id
  doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 0, value: 0 }))
  doc.execute('prop.addKey', JSON.stringify({ layer, path: 'transform/opacity', time: 1, value: 100 }))
  doc.execute('layer.select', JSON.stringify({ layers: [] }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

test('opens a motion project in the Effect kit’s own editor, animates it, and renders through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the Effect kit editor is not built into public/kits/effect-ui')
  test.setTimeout(180_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.ecproj', await introFixture())
  try {
    await expect(kit.getByTestId('effect-status')).toContainText('1 layers', { timeout: 60_000 })
    await expect(kit.getByTestId('effect-menu-Composition')).toHaveText('Composition')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Scrub to the middle; a new text layer from the transport's menu.
    const ruler = (await kit.getByTestId('effect-ruler').boundingBox())!
    await page.mouse.click(ruler.x + ruler.width / 2, ruler.y + ruler.height / 2)
    await expect(kit.getByTestId('effect-timecode')).not.toHaveText('0:00:00:00')
    await kit.getByTestId('effect-new-layer').click()
    await kit.getByTestId('effect-new-text').click()
    await expect(kit.getByTestId('effect-status')).toContainText('2 layers')
    await expect(kit.getByTestId('effect-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('effect-embedded.png') })

    // Rendering writes an MP4 beside the project, as a new file (host/write, export).
    await kit.getByTestId('effect-render').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 120_000 }).toContain('Intro.mp4')

    await kit.getByTestId('effect-save').click()
    await expect(kit.getByTestId('effect-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toContain('Intro.ecproj')
    if (canReadBlobBodies(browserName)) expect(saves.find((save) => save.path === 'Intro.mp4')!.bytes.subarray(4, 8).toString()).toBe('ftyp')
  } finally {
    await host.dispose()
  }
})
