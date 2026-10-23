import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'
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

// The tests click the Classic ribbon's tools (CAD opens in Menus), which needs a wide window (Home:
// about 1630 px beside the sidebar); a narrower one steps down to Single line.
test.use({ viewport: { width: 1920, height: 1000 } })

test('opens a drawing in the CAD kit’s own editor, draws in it, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the CAD kit editor is not built into public/kits/cad-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.dxf', await planFixture(), {}, { modes: { 'kit.cad': 'classic' } })
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

test('keeps a CAD drawing’s replica across a save and a reopen, and opens a file changed elsewhere with what it holds', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the CAD kit editor is not built into public/kits/cad-ui')
  test.skip(!kitPackageHasReplicaInfo('cad', 'kition_cad_sdk'), 'the CAD kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh cad')
  test.setTimeout(180_000)
  const name = 'Replica.dxf'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await planFixture(), {}, { persist: true, modes: { 'kit.cad': 'classic' } })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('cad-status')).toHaveText('1 objects', { timeout: 60_000 })
    const line = kit.getByTestId('cad-command-line')
    for (const text of ['line', '60,60', '200,120', '']) {
      await line.fill(text)
      await line.press('Enter')
    }
    await expect(kit.getByTestId('cad-status')).toHaveText('2 objects')
    // Saved at once, while the empty line that ends the command may still be on its way to the
    // engine: Kit UI saves after the commands in flight, so the unsaved mark still clears.
    await kit.getByTestId('cad-save').click()
    await expect(kit.getByTestId('cad-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.cad')
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the drawing is the replica it was saved with: the line survives, the same version.
    const reopened = await reopen()
    await expect(reopened.getByTestId('cad-status')).toHaveText('2 objects', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('cad-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens with what the file holds, on a replica version
    // the saved one never was.
    await fs.writeFile(path.join(host.root, name), await planFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('cad-status')).toHaveText('1 objects', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
