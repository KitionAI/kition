import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { openInKitFrame, openTreeFile, replicaVersion, serveWorkspace } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'engine')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'kit-ui.json')
const SDK_WASM = path.join(SDK_DIR, 'kition_slide_sdk_bg.wasm')

type NodeSlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeSlideSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  SlideDocument: { create(name: string, width: number, height: number): NodeSlideDocument; open(name: string, bytes: Uint8Array): NodeSlideDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_slide_sdk.js')).href)) as NodeSlideSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** Real slides made by the same engine the page runs: a title slide, and a second slide with a square. */
async function slidesFixture() {
  const sdk = await loadSdk()
  const doc = sdk.SlideDocument.create('Launch.kslide', 960, 540)
  doc.execute('slide.new', '{}')
  doc.execute('shape.insert', JSON.stringify({ preset: 'rect', rect: [380, 170, 200, 200] }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

type InspectedSlide = { shapes: Array<{ preset?: string; text?: string }> }

/** The shapes on slide `index` of a saved slides file. */
async function shapesIn(bytes: Buffer, index: number) {
  const sdk = await loadSdk()
  const doc = sdk.SlideDocument.open('Saved.kslide', bytes)
  const slide = JSON.parse(doc.execute('slide.inspect', JSON.stringify({ index }))) as InspectedSlide
  doc.free()
  return slide.shapes
}

test('opens slides in the Slide kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Slide kit editor is not built into public/kits/slide-ui')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    const fixture = await slidesFixture()
    await fs.writeFile(path.join(host.root, 'Launch.kslide'), fixture)
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const saves: Array<{ path: string | null; bytes: Buffer }> = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path')
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
      saves.push({ path: target, bytes })
      await fulfillJson(route, { code: 200, message: 'success', data: { path: target, bytes: bytes.length } })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Launch' }).first().click()

    // Kition shows the kit's editor in a frame, and the kit draws everything in it.
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('slides-slide-1')).toBeVisible()
    // The slide list draws each slide: the second one has its square.
    const darkPixels = () =>
      kit.getByTestId('slides-slide-1').locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0
        for (let index = 0; data && index < data.length; index += 4) if (data[index] < 200) dark += 1
        return dark
      })
    await expect.poll(darkPixels, { timeout: 20_000 }).toBeGreaterThan(200)
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // The slide list goes to slide 2; a new slide and Undo work in the kit.
    await kit.getByTestId('slides-slide-1').click()
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 2 of 2')
    await kit.locator('.slides-slides-list').press('Enter')
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 3 of 3')
    await expect(kit.getByTestId('slides-unsaved')).toBeVisible()
    await kit.getByRole('button', { name: 'Undo' }).click()
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 2$/)
    await kit.locator('.slides-slides-list').press('Enter')
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 3$/)
    await page.screenshot({ path: testInfo.outputPath('slide-embedded.png') })

    // Save goes through Kition's file API (host/write).
    await kit.getByTestId('slides-save').click()
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Launch.kslide'])
    if (canReadBlobBodies(browserName)) {
      const sdk = await loadSdk()
      const reopened = sdk.SlideDocument.open('Saved.kslide', saves[0].bytes)
      expect((JSON.parse(reopened.inspect()) as { slides: unknown[] }).slides).toHaveLength(3)
      reopened.free()
    }
  } finally {
    await host.dispose()
  }
})

test('keeps a slide file’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Slide kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slide kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
  test.setTimeout(180_000)
  const name = 'Replica.kslide'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await slidesFixture(), {}, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await kit.locator('.slides-slides-list').press('Enter')
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 3$/)
    await kit.getByTestId('slides-save').click()
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.slide')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the slide file is the replica it was saved with: the third slide survives.
    const reopened = await reopen()
    await expect(reopened.getByTestId('slides-status')).toHaveText(/of 3$/, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('slides-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await slidesFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('slides-status')).toHaveText(/of 2$/, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
