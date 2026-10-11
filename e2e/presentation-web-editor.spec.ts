import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'presentation-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_presentation_sdk_bg.wasm')

type NodePresentationDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
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

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8)
  await page.mouse.up()
}

test('edits a deck in the page with the Presentation engine and its own tools, and saves it back', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Presentation engine is not built into public/kits/presentation-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Launch.deckcraft'), await deckFixture())
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

    await expect(page.getByTestId('presentation-status')).toContainText('Slide 1 of 2, 0 selected', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Home')).toBeVisible()
    await expect(page.getByTestId('presentation-tool-select')).toHaveAttribute('aria-pressed', 'true')

    // The Oval tool draws on the current slide, then the rail returns to Select with the oval selected.
    const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
    // O picks the Oval, which shares the Rectangle's place on the rail.
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.press('o')
    await expect(page.getByTestId('presentation-tool-ellipse')).toHaveAttribute('aria-pressed', 'true')
    await drag(page, { x: box.x + box.width * 0.35, y: box.y + box.height * 0.6 }, { x: box.x + box.width * 0.55, y: box.y + box.height * 0.8 })
    await expect(page.getByTestId('presentation-status')).toContainText('1 selected')
    await expect(page.getByTestId('presentation-tool-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()

    // Typing on the selected oval gives it text; Escape leaves the text, then the selection.
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.type('Hello')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('presentation-status')).toContainText('0 selected')
    await page.screenshot({ path: testInfo.outputPath('presentation-web-editor.png') })

    // PageDown goes to the next slide, which comes into view.
    await page.keyboard.press('PageDown')
    await expect(page.getByTestId('presentation-status')).toContainText('Slide 2 of 2')

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Launch.deckcraft'])
    if (canReadBlobBodies(browserName)) {
      const shapes = await shapesIn(saves[0].bytes, 0)
      expect(shapes).toContainEqual(expect.objectContaining({ preset: 'ellipse', text: expect.stringContaining('Hello') }))
    }
  } finally {
    await host.dispose()
  }
})

test('creates a new presentation from the create menu with the Presentation engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Presentation engine is not built into public/kits/presentation-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const written: string[] = []
    // The runtime writes the new file; here the host's folder plays the workspace.
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') ?? ''
      written.push(target)
      await fs.writeFile(path.join(host.root, target), route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-presentation').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled presentation.deckcraft'])
    await expect(page.getByTestId('presentation-status')).toContainText('Slide 1 of 1', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled presentation' })).toBeVisible()
    expect((await shapesIn(await fs.readFile(path.join(host.root, 'Untitled presentation.deckcraft')), 0)).length).toBe(2)
  } finally {
    await host.dispose()
  }
})
