import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type NodeDesignDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ DesignDocument: { create(name: string, width: number, height: number): NodeDesignDocument } }>('design', 'kition_design_sdk')

/** A real layout made by the same engine the page runs: one page with a text frame. */
async function flyerFixture() {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Flyer.kitiondesign', 612, 792)
  doc.execute('frame.create', JSON.stringify({ rect: [54, 72, 558, 200], content: 'text', caret: true }))
  doc.execute('text.insert', JSON.stringify({ text: 'Spring concert' }))
  doc.execute('text.exitToFrame', '{}')
  doc.execute('edit.deselectAll', '{}')
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

test('opens a layout in the Design kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Design kit editor is not built into public/kits/design-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Flyer.kitiondesign', await flyerFixture())
  try {
    await expect(kit.getByTestId('design-status')).toHaveText('1 pages', { timeout: 60_000 })
    await expect(kit.getByTestId('design-menu-Layout')).toHaveText('Layout')
    await expect(kit.getByTestId('design-spread-0')).toBeVisible()
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // A page from the Pages panel, and a layer from the Layers panel.
    await kit.getByTestId('design-add-page').click()
    await expect(kit.getByTestId('design-status')).toHaveText('2 pages')
    await expect(kit.getByTestId('design-unsaved')).toBeVisible()
    await kit.getByTestId('design-new-layer').click()
    await expect(kit.getByTestId('design-layers').getByText('Layer 2')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('design-embedded.png') })

    await kit.getByTestId('design-save').click()
    await expect(kit.getByTestId('design-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Flyer.kitiondesign'])
  } finally {
    await host.dispose()
  }
})
