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
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'word-ui', 'kit-ui.json')
const SDK_WASM = path.join(SDK_DIR, 'kition_word_sdk_bg.wasm')

type NodeWordDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
type NodeWordSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  WordDocument: { create(name: string, width: number, height: number): NodeWordDocument; open(name: string, bytes: Uint8Array): NodeWordDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_word_sdk.js')).href)) as NodeWordSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real document made by the same engine the page runs: a title and a paragraph. */
async function letterFixture() {
  const sdk = await loadSdk()
  const doc = sdk.WordDocument.create('Letter.docx', 612, 792)
  doc.execute('para.style', JSON.stringify({ style: 'Title' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Field notes' }))
  doc.execute('text.newParagraph', '{}')
  doc.execute('para.style', JSON.stringify({ style: 'Normal' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Auroras appear near the poles.' }))
  doc.execute('caret.docStart', '{}')
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

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
    const headers = { etag: `"${stat.mtimeMs}-${stat.size}"`, 'last-modified': stat.mtime.toUTCString(), 'access-control-expose-headers': 'ETag,Content-Range,Accept-Ranges', 'content-type': 'application/octet-stream' }
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' })
    return route.fulfill({ status: 200, headers, body: await fs.readFile(file) })
  })
}

test('opens a Word document in the Word kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Word kit editor is not built into public/kits/word-ui')
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Letter.docx'), await letterFixture())
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
    await page.locator('.document-tree-row', { hasText: 'Letter' }).first().click()

    await expect(page.getByTestId('kit-frame')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('word-style-Title')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Type at the end through the kit's text field, make it bold, and insert a table.
    await kit.getByTestId('word-canvas-region').click({ position: { x: 400, y: 300 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type(' Bring a tripod.')
    await expect(kit.getByTestId('word-unsaved')).toBeVisible()
    await kit.getByTestId('ribbon-tab-insert').click()
    // Kition answers host/pick, so the kit offers Pictures.
    await expect(kit.getByTestId('word-picture')).toBeEnabled()
    await kit.getByTestId('word-table').click()
    await kit.getByTestId('kui-table-2x2').click()
    // Choosing a size closes the menu; the table tabs appear, and Save stays in view.
    await expect(kit.getByTestId('kui-table-2x2')).toHaveCount(0)
    await expect(kit.getByTestId('ribbon-tab-tableLayout')).toBeVisible()
    await expect(kit.getByTestId('word-save')).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('word-embedded.png') })

    // Save goes through Kition's file API (host/write).
    await kit.getByTestId('word-save').click()
    await expect(kit.getByTestId('word-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Letter.docx'])
    if (canReadBlobBodies(browserName)) expect(await textOf(saves[0].bytes)).toContain('Bring a tripod.')
  } finally {
    await host.dispose()
  }
})
