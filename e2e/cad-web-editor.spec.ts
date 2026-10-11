import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'cad-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_cad_sdk_bg.wasm')

type NodeCadDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeCadSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  CadDocument: { create(name: string, width: number, height: number): NodeCadDocument; open(name: string, bytes: Uint8Array): NodeCadDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_cad_sdk.js')).href)) as NodeCadSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real drawing made by the same engine the page runs: A3 limits and one line, typed on its command line. */
async function drawingFixture() {
  const sdk = await loadSdk()
  const doc = sdk.CadDocument.create('Plan.dxf', 420, 297)
  for (const text of ['line', '20,20', '120,80', '']) doc.execute('commandLine', JSON.stringify({ text }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** How many objects a saved drawing holds in model space. */
async function objectsIn(bytes: Buffer) {
  const sdk = await loadSdk()
  const doc = sdk.CadDocument.open('Saved.dxf', bytes)
  const objects = (JSON.parse(doc.inspect()) as { entities: number }).entities
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

/** How many canvas pixels are dark: the drawing's lines, black on white paper. */
function darkPixels(page: Page) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let index = 0; data && index < data.length; index += 4) if (data[index] < 96 && data[index + 1] < 96 && data[index + 2] < 96) dark += 1
    return dark
  })
}

test('drafts in the page with the CAD engine, its command line, and its tools, and saves DXF', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the CAD engine is not built into public/kits/cad-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Plan.dxf'), await drawingFixture())
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
    await page.locator('.document-tree-row', { hasText: 'Plan' }).first().click()

    await expect(page.getByTestId('cad-status')).toContainText('1 objects, 0 selected, layer 0', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Draw')).toBeVisible()
    await expect(page.getByTestId('cad-tool-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('cad-prompt')).toContainText('Command')
    await expect.poll(() => darkPixels(page)).toBeGreaterThan(20)
    const withLine = await darkPixels(page)

    // The command line starts a command; the rail follows it and the prompt asks for its points.
    const line = page.getByTestId('cad-command-line')
    await line.fill('circle')
    await line.press('Enter')
    await expect(page.getByTestId('cad-tool-circle')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('cad-prompt')).toContainText(/center/i)
    await line.fill('210,148')
    await line.press('Enter')
    await line.fill('60')
    await line.press('Enter')
    await expect(page.getByTestId('cad-status')).toContainText('2 objects')
    await expect(page.getByTestId('cad-tool-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await expect.poll(() => darkPixels(page)).toBeGreaterThan(withLine)

    // The Line tool runs the engine's command: clicks answer its prompts, Enter ends it.
    const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
    await page.getByTestId('cad-tool-line').click()
    await expect(page.getByTestId('cad-prompt')).toContainText(/first point/i)
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35)
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.35)
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('cad-status')).toContainText('3 objects')
    await expect(page.getByTestId('cad-tool-select')).toHaveAttribute('aria-pressed', 'true')

    // With no command running, two clicks on empty paper make a selection window around everything.
    await page.mouse.click(box.x + 4, box.y + 4)
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4)
    await expect(page.getByTestId('cad-status')).toContainText('3 selected')
    await page.screenshot({ path: testInfo.outputPath('cad-web-editor.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('cad-status')).toContainText('0 selected')

    // Delete erases the selection; Undo brings it back, then takes back the last line.
    await page.mouse.click(box.x + 4, box.y + 4)
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4)
    await expect(page.getByTestId('cad-status')).toContainText('3 selected')
    await page.keyboard.press('Delete')
    await expect(page.getByTestId('cad-status')).toContainText('0 objects')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('cad-status')).toContainText('3 objects')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('cad-status')).toContainText('2 objects')

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Plan.dxf'])
    if (canReadBlobBodies(browserName)) expect(await objectsIn(saves[0].bytes)).toBe(2)
  } finally {
    await host.dispose()
  }
})

test('creates a new CAD drawing from the create menu with the CAD engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the CAD engine is not built into public/kits/cad-sdk')
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
    await page.getByTestId('workspace-create-cad').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled CAD drawing.dxf'])
    await expect(page.getByTestId('cad-status')).toContainText('0 objects', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled CAD drawing' })).toBeVisible()
    expect(await objectsIn(await fs.readFile(path.join(host.root, 'Untitled CAD drawing.dxf')))).toBe(0)
  } finally {
    await host.dispose()
  }
})
