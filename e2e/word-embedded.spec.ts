import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { openInKitFrame, openTreeFile } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'word-ui', 'engine')
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

/** The replica version of the kit editor showing `path`, as hex (Kition's development test hook). */
function replicaVersion(page: Page, path: string) {
  return page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__ ? window.__KITION_KIT_TEST__.replicaVersion(wanted) : ''), path)
}

test('keeps a Word document’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Word kit editor is not built into public/kits/word-ui')
  test.skip(!kitPackageHasReplicaInfo('word', 'kition_word_sdk'), 'the Word kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh word')
  test.setTimeout(180_000)
  const name = 'Replica.docx'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await letterFixture(), {}, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await kit.getByTestId('word-canvas-region').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type(' A line added before saving.')
    // The kit applies the keys a moment after they are sent: save once its replica holds still,
    // or keys applied after the save leave the letter unsaved again.
    await expect(kit.getByTestId('word-unsaved')).toBeVisible()
    let last = ''
    await expect.poll(async () => {
      const now = await replicaVersion(page, name)
      const still = now !== '' && now === last
      last = now
      return still
    }, { timeout: 15_000, intervals: [300] }).toBe(true)
    await kit.getByTestId('word-save').click()
    await expect(kit.getByTestId('word-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.word')
    expect(await fs.stat(path.join(store, docId, 'blobs.bin'))).toBeTruthy()
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the letter is the replica it was saved with: the same replica version.
    const reopened = await reopen()
    await expect(reopened.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('word-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) still opens with its stored replica (the file wins
    // where they disagree), recorded as a fresh change: a different version, never the old one.
    await fs.writeFile(path.join(host.root, name), await letterFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
