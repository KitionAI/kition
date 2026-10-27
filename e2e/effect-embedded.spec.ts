import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

type NodeEffectDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ EffectDocument: { create(name: string, width: number, height: number): NodeEffectDocument } }>('effect', 'kition_effect_sdk')

test.beforeAll(() => {
  expect(engine.built, 'Build or fetch public/kits/effect-ui before running the Effect gate').toBe(true)
  expect(kitPackageHasReplicaInfo('effect', 'kition_effect_sdk'), 'The Effect package must support replica/info').toBe(true)
})

/** A real project made by the same engine the page runs: a 2-second composition with a fading solid. */
async function introFixture() {
  const sdk = await engine.load()
  const doc = sdk.EffectDocument.create('Intro.keffect', 640, 360)
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
  test.setTimeout(180_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Intro.keffect', await introFixture())
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
    expect(saves.map((save) => save.path)).toContain('Intro.keffect')
    if (canReadBlobBodies(browserName)) expect(saves.find((save) => save.path === 'Intro.mp4')!.bytes.subarray(4, 8).toString()).toBe('ftyp')
  } finally {
    await host.dispose()
  }
})

test('keeps a motion project’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  // A flat name: the document tree's own folder-expand toggle (clicked again on each reopen)
  // would otherwise collapse a folder a previous open already expanded.
  const name = 'Replica.keffect'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await introFixture(), {}, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('effect-status')).toContainText('1 layers', { timeout: 60_000 })
    // A new text layer, then save.
    await kit.getByTestId('effect-new-layer').click()
    await kit.getByTestId('effect-new-text').click()
    await expect(kit.getByTestId('effect-status')).toContainText('2 layers')
    await kit.getByTestId('effect-save').click()
    await expect(kit.getByTestId('effect-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.effect')
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the project is the replica it was saved with: the text layer survives.
    const reopened = await reopen()
    await expect(reopened.getByTestId('effect-status')).toContainText('2 layers', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('effect-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await introFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('effect-status')).toContainText('1 layers', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
