import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'

type NodeVectorDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ VectorDocument: { create(name: string, width: number, height: number): NodeVectorDocument } }>('vector', 'kition_vector_sdk')

/** A real drawing made by the same engine the page runs: one rectangle. */
async function logoFixture() {
  const sdk = await engine.load()
  const doc = sdk.VectorDocument.create('Logo.kvector', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 40, y: 40, width: 120, height: 80 }))
  doc.execute('select.none', '{}')
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

test('opens a drawing in the Vector kit’s own editor, draws in it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Logo.kvector', await logoFixture())
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
    expect(saves.map((save) => save.path)).toEqual(['Logo.kvector'])
  } finally {
    await host.dispose()
  }
})

test('keeps a drawing’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.skip(!kitPackageHasReplicaInfo('vector', 'kition_vector_sdk'), 'the Vector kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh vector')
  test.setTimeout(180_000)
  const name = 'Replica.kvector'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await logoFixture(), {}, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('vector-status')).toContainText('1 objects', { timeout: 60_000 })
    // A second rectangle, drawn with the Rectangle tool.
    await kit.getByTestId('vector-tool-rectangle').click()
    const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
    await page.mouse.move(region.x + region.width * 0.6, region.y + region.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(region.x + region.width * 0.6 + 50, region.y + region.height * 0.6 + 40, { steps: 5 })
    await page.mouse.up()
    await expect(kit.getByTestId('vector-status')).toContainText('2 objects')
    await kit.getByTestId('vector-save').click()
    await expect(kit.getByTestId('vector-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.vector')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the drawing is the replica it was saved with: the second rectangle survives.
    const reopened = await reopen()
    await expect(reopened.getByTestId('vector-status')).toContainText('2 objects', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('vector-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await logoFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('vector-status')).toContainText('1 objects', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
