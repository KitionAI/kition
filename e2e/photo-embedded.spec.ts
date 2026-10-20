import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile } from './helpers/embeddedKit'
import { versionCounters } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'

type NodePhotoDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ PhotoDocument: { create(name: string, width: number, height: number): NodePhotoDocument } }>('photo', 'kition_photo_sdk')

/** A real image made by the same engine the page runs: a background and one pixel layer. */
async function posterFixture(width = 480, height = 320) {
  const sdk = await engine.load()
  const doc = sdk.PhotoDocument.create('Poster.psd', width, height)
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
    // Kition's floating Agent launcher steps aside for the kit, whose panels reach the right edge
    // (it covered the Layers panel's buttons); the kit's own "Ask agent" opens the Agent.
    await expect(page.getByTestId('agent-floating-launcher')).toBeHidden()

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

/** The replica's version as sorted author counters ('' while there is none): a version's bytes list
 * its authors in no fixed order, so two equal versions can encode differently. */
async function replicaVersion(page: Page, path: string) {
  const hex = await page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.replicaVersion(wanted) : ''), path)
  return hex ? JSON.stringify(versionCounters(hex)) : ''
}

test('keeps a PSD’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.setTimeout(180_000)
  const name = 'Replica.psd'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await posterFixture(96, 64), {}, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    await kit.getByTestId('photo-layer-new').click()
    await expect(kit.getByTestId('photo-status')).toContainText('3 layers')
    await kit.getByTestId('photo-save').click()
    await expect(kit.getByTestId('photo-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.photo')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the image is the replica it was saved with.
    const reopened = await reopen()
    await expect(reopened.getByTestId('photo-status')).toContainText('3 layers', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('photo-unsaved')).toHaveCount(0)

    // A second save appends only its changes after the stored snapshot; reopened, the image is both.
    await reopened.getByTestId('photo-layer-new').click()
    await expect(reopened.getByTestId('photo-status')).toContainText('4 layers')
    await reopened.getByTestId('photo-save').click()
    await expect(reopened.getByTestId('photo-unsaved')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).changes?.length ?? 0, { timeout: 15_000 }).toBe(1)
    const appended = await replicaVersion(page, name)
    const again = await reopen()
    await expect(again.getByTestId('photo-status')).toContainText('4 layers', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(appended)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await posterFixture(96, 64))
    const changed = await reopen()
    await expect(changed.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
