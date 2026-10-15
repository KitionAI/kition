import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'
import { openInKitFrame } from './helpers/embeddedKit'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'presentation-sdk')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'presentation-ui', 'kit-ui.json')
const SDK_WASM = path.join(SDK_DIR, 'kition_presentation_sdk_bg.wasm')

type NodePresentationDocument = { save(name?: string): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodePresentationSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  PresentationDocument: { create(name: string, width: number, height: number): NodePresentationDocument; open(name: string, bytes: Uint8Array): NodePresentationDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_presentation_sdk.js')).href)) as NodePresentationSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real deck made by the same engine the page runs: a title slide, and a second slide with a square. */
async function deckFixture() {
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.create('Launch.deckcraft', 960, 540)
  doc.execute('slide.new', '{}')
  doc.execute('shape.insert', JSON.stringify({ preset: 'rect', rect: [380, 170, 200, 200] }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

type InspectedSlide = { shapes: Array<{ preset?: string; text?: string }> }

/** The shapes on slide `index` of a saved deck. */
async function shapesIn(bytes: Buffer, index: number) {
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.open('Saved.deckcraft', bytes)
  const slide = JSON.parse(doc.execute('slide.inspect', JSON.stringify({ index }))) as InspectedSlide
  doc.free()
  return slide.shapes
}

async function serveWorkspace(page: Page, root: string) {
  await page.route('**/workspace-files/**', async (route: Route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/workspace-files\//, ''))
    const file = path.join(root, relative)
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    const stat = await fs.stat(file)
    // As the runtime's file server: Last-Modified (readable across origins) and the same exposed headers.
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

test('pages a fitted deck with the wheel in the packaged editor without moving its canvas', async ({ page, baseURL }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Presentation editor package is not built')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1594, height: 887 })
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.create('Scrolling.deckcraft', 960, 540)
  for (let index = 1; index < 7; index += 1) doc.execute('slide.new', JSON.stringify({ title: `Slide ${index + 1}` }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Scrolling.deckcraft', bytes)
  try {
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 1 of 7', { timeout: 60_000 })
    const surface = kit.getByTestId('kit-canvas-surface')
    await kit.getByRole('button', { name: 'Fit', exact: true }).click()
    await page.waitForTimeout(500)
    // Compare the paper edges: engine hover outlines may change pixels after the mouse enters.
    const paperBounds = () => surface.evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4
          if (data[offset] > 250 && data[offset + 1] > 250 && data[offset + 2] > 250) {
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
      }
      return { left, top, right, bottom }
    })
    const first = await paperBounds()
    expect(first.right).toBeGreaterThan(first.left)
    await surface.screenshot({ path: testInfo.outputPath('presentation-before-wheel.png') })
    const bounds = (await surface.boundingBox())!
    const wheel = async (dy: number) => {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.wheel(0, dy)
      await page.waitForTimeout(450)
    }
    await wheel(120)
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 2 of 7')
    await wheel(-120)
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 1 of 7')
    await page.waitForTimeout(300)
    expect(await paperBounds()).toEqual(first)
    expect(await surface.boundingBox()).toEqual(bounds)
    await wheel(-600)
    expect(await paperBounds()).toEqual(first)

    for (let index = 1; index < 7; index += 1) {
      await wheel(120)
      await expect(kit.getByTestId('deck-status')).toHaveText(`Slide ${index + 1} of 7`)
    }
    await expect(kit.getByTestId('deck-slide-6')).toBeInViewport()
    await page.waitForTimeout(300)
    const last = await paperBounds()
    await wheel(600)
    expect(await paperBounds()).toEqual(last)
    const list = (await kit.locator('.deck-slides-list').boundingBox())!
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2)
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(450)
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 7 of 7')
    expect(await paperBounds()).toEqual(last)
    expect(await surface.boundingBox()).toEqual(bounds)
    await page.screenshot({ path: testInfo.outputPath('presentation-wheel.png') })
  } finally {
    await host.dispose()
  }
})

test('loads the native ribbon and functional views from the Presentation package used by Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Presentation editor package is not built')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1594, height: 887 })
  const sdk = await loadSdk()
  const doc = sdk.PresentationDocument.open('Ribbon.deckcraft', await deckFixture())
  const bytes = Buffer.from(doc.save('Ribbon.pptx'))
  doc.free()
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Ribbon.pptx', bytes)
  try {
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    for (const id of ['home', 'insert', 'draw', 'design', 'transitions', 'animations', 'slideShow', 'record', 'review', 'view']) await expect(kit.getByTestId(`ribbon-tab-${id}`)).toBeVisible()
    await kit.getByTestId('ribbon-tab-view').click()
    for (const label of ['Normal', 'Outline View', 'Slide Sorter', 'Notes Page', 'Reading View', 'Slide Master', 'Handout Master', 'Notes Master', 'Notes', 'Zoom', 'Fit', 'Grayscale', 'Dark Mode']) await expect(kit.getByRole('tabpanel').getByRole('button', { name: label, exact: true })).toBeVisible()
    await kit.getByTestId('deck-view-sorter').click()
    await expect(kit.getByTestId('deck-sorter')).toBeVisible()
    await kit.getByTestId('deck-slide-1').click()
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 2 of 2')
    await kit.getByTestId('deck-view-outline').click()
    await expect(kit.locator('.deck-outline-text')).toHaveCount(2)
    await kit.getByTestId('deck-view-notesPage').click()
    await expect(kit.getByTestId('deck-notes-page')).toBeVisible()
    await kit.getByTestId('deck-view-normal').click()
    await kit.getByTestId('deck-view-ruler').check()
    await expect(kit.getByTestId('deck-ruler-x')).toBeVisible()
    await kit.getByTestId('deck-view-ruler').uncheck()
    await kit.getByTestId('deck-view-master').click()
    await expect(kit.getByTestId('deck-master-list')).toBeVisible()
    await expect(kit.getByTestId('ribbon-tab-slideMaster')).toBeVisible()
    await kit.getByTestId('ribbon-tab-slideMaster').click()
    await kit.getByTestId('deck-cmd-view.closeMaster').click()
    await kit.getByTestId('ribbon-tab-insert').click()
    await kit.getByTestId('deck-insert-chart').click()
    await kit.getByTestId('deck-chart-line').click()
    await expect(kit.getByTestId('ribbon-tab-chartDesign')).toBeVisible()
    await kit.getByTestId('ribbon-tab-chartDesign').click()
    await kit.getByTestId('deck-cmd-chart.type').click()
    await expect(kit.getByRole('dialog')).toBeVisible()
    await kit.locator('#param-type').fill('pie')
    await kit.getByTestId('command-dialog-run').click()
    await expect(kit.getByRole('dialog')).toHaveCount(0)
    await kit.getByTestId('ribbon-tab-view').click()
    await page.screenshot({ path: testInfo.outputPath('presentation-ribbon.png') })
  } finally {
    await host.dispose()
  }
})

test('opens a deck in the Presentation kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Presentation kit editor is not built into public/kits/presentation-ui')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    const fixture = await deckFixture()
    await fs.writeFile(path.join(host.root, 'Launch.deckcraft'), fixture)
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
    await expect(page.getByTestId('kit-frame')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('deck-slide-1')).toBeVisible()
    // The slide list draws each slide: the second one has its square.
    const darkPixels = () =>
      kit.getByTestId('deck-slide-1').locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0
        for (let index = 0; data && index < data.length; index += 4) if (data[index] < 200) dark += 1
        return dark
      })
    await expect.poll(darkPixels, { timeout: 20_000 }).toBeGreaterThan(200)
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // The slide list goes to slide 2; a new slide and Undo work in the kit.
    await kit.getByTestId('deck-slide-1').click()
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 2 of 2')
    await kit.getByTestId('deck-add-slide').click()
    await expect(kit.getByTestId('deck-status')).toHaveText('Slide 3 of 3')
    await expect(kit.getByTestId('deck-unsaved')).toBeVisible()
    await kit.getByRole('button', { name: 'Undo' }).click()
    await expect(kit.getByTestId('deck-status')).toHaveText(/of 2$/)
    await kit.getByTestId('deck-add-slide').click()
    await expect(kit.getByTestId('deck-status')).toHaveText(/of 3$/)
    await page.screenshot({ path: testInfo.outputPath('presentation-embedded.png') })

    // Save goes through Kition's file API (host/write).
    await kit.getByTestId('deck-save').click()
    await expect(kit.getByTestId('deck-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Launch.deckcraft'])
    if (canReadBlobBodies(browserName)) {
      const sdk = await loadSdk()
      const reopened = sdk.PresentationDocument.open('Saved.deckcraft', saves[0].bytes)
      expect((JSON.parse(reopened.inspect()) as { slides: unknown[] }).slides).toHaveLength(3)
      reopened.free()
    }
  } finally {
    await host.dispose()
  }
})
