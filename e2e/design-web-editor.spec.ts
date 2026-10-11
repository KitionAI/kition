import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'design-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_design_sdk_bg.wasm')

type NodeDesignDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeDesignSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  DesignDocument: { create(name: string, width: number, height: number): NodeDesignDocument; open(name: string, bytes: Uint8Array): NodeDesignDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_design_sdk.js')).href)) as NodeDesignSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** The text of each story in a saved layout. */
async function storiesIn(bytes: Buffer) {
  const doc = (await loadSdk()).DesignDocument.open('Saved.designcraft', bytes)
  const stories = (JSON.parse(doc.inspect()) as { stories: Array<{ preview: string }> }).stories.map((story) => story.preview)
  doc.free()
  return stories
}

/** A Letter page width and height, in points. */
const PAGE = { width: 612, height: 792 }
/** The red frame on page 1, in page points. */
const RED = { x0: 72, y0: 72, x1: 216, y1: 144 }

/** A real two-page layout made by the same engine the page runs, with a red frame on page 1. */
async function layoutFixture() {
  const doc = (await loadSdk()).DesignDocument.create('Flyer.designcraft', PAGE.width, PAGE.height)
  doc.execute('swatch.create', JSON.stringify({ name: 'Red', color: '#ff0000' }))
  const frame = JSON.parse(doc.execute('frame.create', JSON.stringify({ rect: [RED.x0, RED.y0, RED.x1, RED.y1], content: 'unassigned' }))) as { id: number }
  doc.execute('object.fill', JSON.stringify({ swatch: 'Red', ids: [frame.id] }))
  doc.execute('layout.pages.insert', JSON.stringify({ count: 1 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
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

/**
 * Where a point of page 1 is on screen. The editor opens on the first spread, fitted and
 * centred, so the page's centre is the canvas centre and the zoom is the status bar's.
 */
async function onPage1(page: Page, x: number, y: number) {
  const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
  const zoom = Number((await page.getByTestId('kit-status-bar').innerText()).match(/(\d+)%/)?.[1] ?? 100) / 100
  return { x: box.x + box.width / 2 + (x - PAGE.width / 2) * zoom, y: box.y + box.height / 2 + (y - PAGE.height / 2) * zoom }
}

function pixelAt(page: Page, at: { x: number; y: number }) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement, point) => {
    const box = canvas.getBoundingClientRect()
    const scale = canvas.width / box.width
    const data = canvas.getContext('2d')?.getImageData(Math.floor((point.x - box.left) * scale), Math.floor((point.y - box.top) * scale), 1, 1).data
    return data ? [data[0], data[1], data[2]] : null
  }, at)
}

test('lays out pages in the page with the Design engine and its own tools, and saves the layout', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Design engine is not built into public/kits/design-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Flyer.designcraft'), await layoutFixture())
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
    await page.locator('.document-tree-row', { hasText: 'Flyer' }).first().click()

    await expect(page.getByTestId('design-status')).toContainText('2 pages, 0 stories, 0 selected', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Layout')).toBeVisible()
    await expect(page.getByTestId(/^design-spread-/)).toHaveCount(2)
    const red = await onPage1(page, (RED.x0 + RED.x1) / 2 + 20, (RED.y0 + RED.y1) / 2 + 10)
    await expect.poll(() => pixelAt(page, red)).toEqual([255, 0, 0])

    // The Selection tool runs in the engine: a click selects the frame.
    await page.mouse.click(red.x, red.y)
    await expect(page.getByTestId('design-status')).toContainText('1 selected')

    // T picks the Type tool; a drag makes a text frame and typing fills it, from the first key
    // (typed at once, before the engine has answered the drag).
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.press('t')
    await expect(page.getByTestId('design-tool-type')).toHaveAttribute('aria-pressed', 'true')
    const from = await onPage1(page, 72, 400)
    const to = await onPage1(page, 400, 500)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
    await page.mouse.move(to.x, to.y)
    await page.mouse.up()
    await page.keyboard.type('Hello Kition')
    await expect(page.getByTestId('design-status')).toContainText('1 stories')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('design-web-editor.png') })
    await page.keyboard.press('Escape')

    // The Pages panel adds a page; undo takes it back.
    await page.getByTestId('design-add-page').click()
    await expect(page.getByTestId('design-status')).toContainText('3 pages')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('design-status')).toContainText('2 pages')

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(saves.map((save) => save.path)).toEqual(['Flyer.designcraft'])
    if (canReadBlobBodies(browserName)) {
      expect(saves[0].bytes.subarray(0, 2).toString()).toBe('PK')
      expect(await storiesIn(saves[0].bytes)).toEqual(['Hello Kition'])
    }
  } finally {
    await host.dispose()
  }
})

test('creates a new layout from the create menu with the Design engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Design engine is not built into public/kits/design-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await serveWorkspace(page, host.root)
    const written: string[] = []
    await page.route('**/api/v1/kits/files?**', async (route) => {
      const target = new URL(route.request().url()).searchParams.get('path') ?? ''
      written.push(target)
      await fs.writeFile(path.join(host.root, target), route.request().postDataBuffer() ?? Buffer.alloc(0))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-layout').click()

    await expect.poll(() => written).toEqual(['Untitled layout.designcraft'])
    await expect(page.getByTestId('design-status')).toContainText('1 pages, 0 stories', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled layout' })).toBeVisible()
  } finally {
    await host.dispose()
  }
})
