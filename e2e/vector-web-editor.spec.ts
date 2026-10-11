import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'vector-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_vector_sdk_bg.wasm')

type NodeVectorDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeVectorSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  VectorDocument: { create(name: string, width: number, height: number): NodeVectorDocument; open(name: string, bytes: Uint8Array): NodeVectorDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_vector_sdk.js')).href)) as NodeVectorSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real drawing made by the same engine the page runs: a 400 x 300 pt artboard with a red square in the middle. */
async function drawingFixture() {
  const sdk = await loadSdk()
  const doc = sdk.VectorDocument.create('Logo.vectorcraft', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 150, y: 100, width: 100, height: 100 }))
  doc.execute('paint.setFill', JSON.stringify({ color: '#ff0000' }))
  doc.execute('select.none', '{}')
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** How many objects a saved drawing holds on its one layer. */
async function objectsIn(bytes: Buffer) {
  const sdk = await loadSdk()
  const doc = sdk.VectorDocument.open('Saved.vectorcraft', bytes)
  // `objects` counts the layer too.
  const objects = (JSON.parse(doc.inspect()) as { objects: number }).objects - 1
  doc.free()
  return objects
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

/** The canvas pixel at fractions (`fx`, `fy`) of its box. */
function pixel(page: Page, fx = 0.5, fy = 0.5) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement, [x, y]) => {
    const data = canvas.getContext('2d')?.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  }, [fx, fy])
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8)
  await page.mouse.up()
}

test('edits a drawing in the page with the Vector engine and its own tools, and saves it back', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Vector engine is not built into public/kits/vector-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Logo.vectorcraft'), await drawingFixture())
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
    await page.locator('.document-tree-row', { hasText: 'Logo' }).first().click()

    await expect(page.getByTestId('kit-editor')).toBeVisible()
    await expect(page.getByTestId('vector-status')).toContainText('1 objects on 1 artboards, 0 selected', { timeout: 30_000 })
    await expect(page.getByTestId('vector-layers-panel')).toContainText('Layer 1')
    await expect(page.getByTestId('kit-menu-Object')).toBeVisible()
    await expect(page.getByTestId('vector-tool-selection')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => pixel(page)).toEqual([255, 0, 0])

    // The Selection tool runs in the engine: a click on the square selects it, and the engine's
    // selection overlay (outline, anchors, bounding box) is drawn in the layer's colour.
    const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.click(centre.x, centre.y)
    await expect(page.getByTestId('vector-status')).toContainText('1 selected')
    await expect(page.getByTestId('vector-selection-size')).toContainText('W 100 pt × H 100 pt')
    // The square's centre point, an engine overlay, in Layer 1's colour.
    await expect.poll(() => pixel(page)).toEqual([79, 128, 255])

    // Dragging moves it, through the engine's own tool.
    await drag(page, centre, { x: centre.x + box.width * 0.35, y: centre.y })
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await expect.poll(() => pixel(page, 0.47)).not.toEqual([255, 0, 0])
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => pixel(page, 0.47)).toEqual([255, 0, 0])

    // M picks the Rectangle tool; a drag draws a second object.
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.press('m')
    await expect(page.getByTestId('vector-tool-rectangle')).toHaveAttribute('aria-pressed', 'true')
    await drag(page, { x: box.x + box.width * 0.1, y: box.y + box.height * 0.1 }, { x: box.x + box.width * 0.25, y: box.y + box.height * 0.25 })
    await expect(page.getByTestId('vector-status')).toContainText('2 objects')
    await page.screenshot({ path: testInfo.outputPath('vector-web-editor.png') })

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Logo.vectorcraft'])
    if (canReadBlobBodies(browserName)) expect(await objectsIn(saves[0].bytes)).toBe(2)
  } finally {
    await host.dispose()
  }
})

test('creates a new drawing from the create menu with the Vector engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Vector engine is not built into public/kits/vector-sdk')
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
    await page.getByTestId('workspace-create-drawing').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled drawing.vectorcraft'])
    await expect(page.getByTestId('vector-status')).toContainText('0 objects on 1 artboards', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled drawing' })).toBeVisible()
    expect(await objectsIn(await fs.readFile(path.join(host.root, 'Untitled drawing.vectorcraft')))).toBe(0)
  } finally {
    await host.dispose()
  }
})
