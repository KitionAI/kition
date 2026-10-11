import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'sheet-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_sheet_sdk_bg.wasm')

type NodeSheetDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeSheetSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  SheetDocument: { create(name: string, width: number, height: number): NodeSheetDocument; open(name: string, bytes: Uint8Array): NodeSheetDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_sheet_sdk.js')).href)) as NodeSheetSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real workbook made by the same engine the page runs: two costs and their sum. */
async function budgetFixture() {
  const sdk = await loadSdk()
  const doc = sdk.SheetDocument.create('Budget.xlsx', 0, 0)
  for (const [cell, input] of [['A1', 'Item'], ['B1', 'Cost'], ['A2', 'Rent'], ['B2', '1200'], ['A3', 'Food'], ['B3', '450'], ['B4', '=SUM(B2:B3)']]) {
    doc.execute('cell.set', JSON.stringify({ cell, input }))
  }
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** A cell of a saved workbook. */
async function cellOf(bytes: Buffer, cell: string) {
  const sdk = await loadSdk()
  const doc = sdk.SheetDocument.open('Saved.xlsx', bytes)
  const value = JSON.parse(doc.execute('cell.get', JSON.stringify({ cell }))) as { value: unknown; formula?: string }
  doc.free()
  return value
}

/** How many canvas pixels are dark: the cells' text (a light face, antialiased). */
function darkPixels(page: Page) {
  return page.getByTestId('kit-canvas-surface').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let index = 0; data && index < data.length; index += 4) if (data[index] < 140 && data[index + 1] < 140 && data[index + 2] < 140) dark += 1
    return dark
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

test('edits a workbook in the page with the Sheet engine, its grid, and its formula bar, and saves it back', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Sheet engine is not built into public/kits/sheet-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Budget.xlsx'), await budgetFixture())
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
    await page.locator('.document-tree-row', { hasText: 'Budget' }).first().click()

    await expect(page.getByTestId('sheet-status')).toContainText('Sheet1, A1', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-Formulas')).toBeVisible()
    await expect(page.getByTestId('sheet-prompt')).toHaveText('A1: Item')
    await expect.poll(() => darkPixels(page)).toBeGreaterThan(50)

    // Arrows move the active cell; typing enters it on Enter, and the sum follows.
    await page.getByTestId('kit-editor').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByTestId('sheet-prompt')).toHaveText('B2: 1200')
    await page.keyboard.type('99')
    await expect(page.getByTestId('sheet-prompt')).toHaveText('B2: 99')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('sheet-prompt')).toHaveText('B3: 450')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()

    // The formula bar enters a formula in the active cell.
    const bar = page.getByTestId('sheet-command-line')
    await bar.fill('=B2*2')
    await bar.press('Enter')
    // B3 now doubles B2; the bar moves on to B4 and shows its formula.
    await expect(page.getByTestId('sheet-prompt')).toHaveText('B4: =SUM(B2:B3)')
    await page.screenshot({ path: testInfo.outputPath('sheet-web-editor.png') })

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Budget.xlsx'])
    if (canReadBlobBodies(browserName)) {
      expect((await cellOf(saves[0].bytes, 'B2')).value).toBe(99)
      expect((await cellOf(saves[0].bytes, 'B4')).value).toBe(297)
    }
  } finally {
    await host.dispose()
  }
})

test('creates a new spreadsheet from the create menu with the Sheet engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Sheet engine is not built into public/kits/sheet-sdk')
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
    await page.getByTestId('workspace-create-spreadsheet').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled spreadsheet.xlsx'])
    await expect(page.getByTestId('sheet-status')).toContainText('Sheet1, A1', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled spreadsheet' })).toBeVisible()
    expect((await cellOf(await fs.readFile(path.join(host.root, 'Untitled spreadsheet.xlsx')), 'A1')).value).toBeNull()
  } finally {
    await host.dispose()
  }
})
