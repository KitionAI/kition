import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'word-sdk')
const SDK_WASM = path.join(SDK_DIR, 'kition_word_sdk_bg.wasm')

type NodeWordDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
type NodeWordSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  WordDocument: { create(name: string, width: number, height: number): NodeWordDocument; open(name: string, bytes: Uint8Array): NodeWordDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_word_sdk.js')).href)) as NodeWordSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real document made by the same engine the page runs: one paragraph. */
async function letterFixture() {
  const sdk = await loadSdk()
  const doc = sdk.WordDocument.create('Letter.docx', 612, 792)
  doc.execute('text.insert', JSON.stringify({ text: 'Dear reader, this is a test.' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** A saved document's text. */
async function textOf(bytes: Buffer) {
  const sdk = await loadSdk()
  const doc = sdk.WordDocument.open('Saved.docx', bytes)
  const text = (JSON.parse(doc.execute('document.text', '{}')) as { text: string }).text
  doc.free()
  return text
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

test('types in a Word document in the page with the Word engine, and saves it back', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM), 'the Word engine is not built into public/kits/word-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Letter.docx'), await letterFixture())
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has word-embedded.spec.ts.
    await page.route('**/kits/word-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
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
    await page.locator('.document-tree-row', { hasText: 'Letter' }).first().click()

    await expect(page.getByTestId('word-status')).toContainText('Page 1 of 1, 6 words', { timeout: 30_000 })
    await expect(page.getByTestId('kit-menu-References')).toBeVisible()

    // A click in the page places the caret; Cmd+Home goes to the start, and typing goes there.
    const box = (await page.getByTestId('kit-canvas-surface').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.type('Hello ')
    await expect(page.getByTestId('word-status')).toContainText('7 words')
    await expect(page.getByTestId('kit-unsaved')).toBeVisible()
    // Backspace and Enter are the engine's editing keys.
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('word-status')).toContainText('7 words')
    await page.screenshot({ path: testInfo.outputPath('word-web-editor.png') })

    await page.getByTestId('kit-save').click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('kit-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Letter.docx'])
    if (canReadBlobBodies(browserName)) expect(await textOf(saves[0].bytes)).toMatch(/^Hello\s*\n\s*Dear reader/)
  } finally {
    await host.dispose()
  }
})

test('creates a new Word document from the create menu with the Word engine', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'it opens the file it wrote, and Playwright cannot read Blob bodies in WebKit')
  test.skip(!existsSync(SDK_WASM), 'the Word engine is not built into public/kits/word-sdk')
  test.setTimeout(90_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    // This spec covers Kition's own editor for the kit; the kit's embedded one has word-embedded.spec.ts.
    await page.route('**/kits/word-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
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
    await page.getByTestId('workspace-create-word').click()

    await expect.poll(() => written, { timeout: 60_000 }).toEqual(['Untitled Word document.docx'])
    await expect(page.getByTestId('word-status')).toContainText('Page 1 of 1, 0 words', { timeout: 60_000 })
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled Word document' })).toBeVisible()
    expect((await textOf(await fs.readFile(path.join(host.root, 'Untitled Word document.docx')))).trim()).toBe('')
  } finally {
    await host.dispose()
  }
})
