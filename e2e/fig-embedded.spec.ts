import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'

/**
 * Kition's interface designs are `.kfig` files the Fig kit (`kit.fig`, KitionAI/kition-fig) edits
 * in its own editor (KitFrame). This covers what Kition adds around the kit: opening a design from
 * the tree, editing it, saving through Kition's file API, and the create menu making a new design
 * with the kit's engine in the page. The editor's own behavior is tested in the kit's repository.
 */

type NodeFigDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ FigDocument: { create(name: string, width: number, height: number): NodeFigDocument; open(name: string, bytes: Uint8Array): NodeFigDocument } }>('fig', 'kition_fig_sdk')
const missing = 'the Fig kit is not built into public/kits/fig-ui (scripts/build-kit-ui.sh fig)'

/** A design made by the engine the page runs: the starter frame and a rectangle on it. */
async function screenFixture() {
  const sdk = await engine.load()
  const doc = sdk.FigDocument.create('Screen.kfig', 1440, 1024)
  doc.execute('shape.rectangle', JSON.stringify({ x: 120, y: 120, width: 320, height: 200 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The number of layers in a saved design, as the engine reads it. */
async function layersOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.FigDocument.open('Saved.kfig', bytes)
  const layers = (JSON.parse(doc.inspect()) as { layers: number }).layers
  doc.free()
  return layers
}

test('opens a design in the Fig kit’s own editor, edits it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const fixture = await screenFixture()
  expect(await layersOf(fixture)).toBe(2)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kfig', fixture)
  try {
    await expect(kit.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Draw a rectangle with the toolbar's shape tool on the canvas.
    await kit.getByTestId('fig-caret-shape').click()
    await kit.getByTestId('fig-flyout-tool-rectangle').click()
    const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
    const from = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
    await page.mouse.move(from.x + 80, from.y + 60, { steps: 6 })
    await page.mouse.up()
    await page.screenshot({ path: testInfo.outputPath('fig-embedded.png') })

    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['Screen.kfig'])
    expect(await layersOf(saves[0]!.bytes)).toBe(3)
  } finally {
    await host.dispose()
  }
})

test('makes a new design with the Fig kit’s engine from the create menu and opens it in the kit', async ({ page, baseURL }) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('group', { name: 'Visual' }).getByTestId('workspace-create-fig').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled fig.kfig'])
    // The starter design: one frame of the create size.
    expect(await layersOf(saves[0]!.bytes)).toBe(1)
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('fig-toolbar')).toBeVisible({ timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})
