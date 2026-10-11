import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'pdf-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_pdf_sdk_bg.wasm')

type NodePdfDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodePdfSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  PdfDocument: { create(name: string, width: number, height: number): NodePdfDocument; open(name: string, bytes: Uint8Array): NodePdfDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_pdf_sdk.js')).href)) as NodePdfSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real PDF made by the same engine the page runs: two Letter pages, the first with a watermark. */
async function reportFixture() {
  const sdk = await loadSdk()
  const doc = sdk.PdfDocument.create('Report.pdf', 612, 792)
  doc.execute('page_insert_blank', JSON.stringify({ at: 2 }))
  doc.execute('doc_watermark', JSON.stringify({ pages: [1], text: 'DRAFT', opacity: 1 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** A saved PDF's pages and whether it opens cleanly. */
async function pagesIn(bytes: Buffer) {
  const sdk = await loadSdk()
  const doc = sdk.PdfDocument.open('Saved.pdf', bytes)
  const pages = (JSON.parse(doc.inspect()) as { pages: unknown[] }).pages.length
  doc.free()
  return pages
}

/** How many canvas pixels are neither paper nor pasteboard: the watermark. */
function markedPixels(page: Page) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    let marked = 0
    for (let index = 0; data && index < data.length; index += 4) if (data[index] < 200 && Math.abs(data[index] - data[index + 2]) < 40) marked += 1
    return marked
  })
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

test('opens a PDF in the page with the PDF engine, edits it from the menus, and saves it back', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the PDF engine is not built into public/kits/pdf-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    const fixture = await reportFixture()
    await fs.writeFile(path.join(host.root, 'Report.pdf'), fixture)
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has pdf-embedded.spec.ts.
    await page.route('**/kits/pdf-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
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
    await page.locator('.document-tree-row', { hasText: 'Report' }).first().click()

    await expect(page.getByTestId('pdf-status')).toContainText('2 pages', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Pages')).toBeVisible()
    // The first page, with its watermark, rendered by the engine.
    await expect.poll(() => markedPixels(page)).toBeGreaterThan(200)

    // Document > Flatten edits the file; Undo takes it back.
    await page.getByTestId('kit-menu-Document').click()
    await page.getByTestId('kit-menu-command-doc_flatten').click()
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled()
    await page.getByRole('button', { name: 'Redo' }).click()
    await page.screenshot({ path: testInfo.outputPath('pdf-web-editor.png') })

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Report.pdf'])
    if (canReadBlobBodies(browserName)) {
      // An incremental save: the original file first, any edit appended (Flatten has no comments
      // or fields to flatten here, so the file may come back as it was).
      expect(saves[0].bytes.length).toBeGreaterThanOrEqual(fixture.length)
      expect(saves[0].bytes.subarray(0, fixture.length).equals(fixture)).toBe(true)
      expect(await pagesIn(saves[0].bytes)).toBe(2)
    }
  } finally {
    await host.dispose()
  }
})

test('creates a new PDF from the create menu with the PDF engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the PDF engine is not built into public/kits/pdf-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has pdf-embedded.spec.ts.
    await page.route('**/kits/pdf-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
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
    await page.getByTestId('workspace-create-pdf').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled PDF.pdf'])
    await expect(page.getByTestId('pdf-status')).toContainText('1 pages', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled PDF' })).toBeVisible()
    expect(await pagesIn(await fs.readFile(path.join(host.root, 'Untitled PDF.pdf')))).toBe(1)
  } finally {
    await host.dispose()
  }
})
