import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { openInKitFrame, openTreeFile, pinKitModes, replicaVersion, serveWorkspace } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

const SDK_DIR = path.join(process.cwd(), 'public', 'kits', 'doc-ui', 'engine')
const UI_MARKER = path.join(process.cwd(), 'public', 'kits', 'doc-ui', 'kit-ui.json')
const SDK_WASM = path.join(SDK_DIR, 'kition_doc_sdk_bg.wasm')

type NodeDocDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
type NodeDocSdk = {
  default: (input: { module_or_path: Buffer }) => Promise<unknown>
  DocDocument: { create(name: string, width: number, height: number): NodeDocDocument; open(name: string, bytes: Uint8Array): NodeDocDocument }
}

async function loadSdk() {
  const sdk = (await import(pathToFileURL(path.join(SDK_DIR, 'kition_doc_sdk.js')).href)) as NodeDocSdk
  await sdk.default({ module_or_path: await fs.readFile(SDK_WASM) })
  return sdk
}

/** A real document made by the same engine the page runs: a title and a paragraph. */
async function letterFixture() {
  const sdk = await loadSdk()
  const doc = sdk.DocDocument.create('Letter.docx', 612, 792)
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
  const doc = sdk.DocDocument.open('Saved.docx', bytes)
  const text = (JSON.parse(doc.execute('document.text', '{}')) as { text: string }).text
  doc.free()
  return text
}

// The tests click the Classic ribbon, which needs a wide window: a narrower one steps down to Single line.
test.use({ viewport: { width: 1920, height: 1000 } })

test('opens a Doc document in the Doc kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Doc kit editor is not built into public/kits/doc-ui')
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

    // The test clicks the Classic ribbon's buttons.
    await pinKitModes(page, { 'kit.doc': 'classic' })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Letter' }).first().click()

    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('doc-style-Title')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Type at the end through the kit's text field, make it bold, and insert a table.
    await kit.getByTestId('doc-canvas-region').click({ position: { x: 400, y: 300 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type(' Bring a tripod.')
    await expect(kit.getByTestId('doc-unsaved')).toBeVisible()
    await kit.getByTestId('ribbon-tab-insert').click()
    // Kition answers host/pick, so the kit offers Pictures.
    await expect(kit.getByTestId('doc-picture')).toBeEnabled()
    await kit.getByTestId('doc-table').click()
    await kit.getByTestId('kui-table-2x2').click()
    // Choosing a size closes the menu; the table tabs appear, and Save stays in view.
    await expect(kit.getByTestId('kui-table-2x2')).toHaveCount(0)
    await expect(kit.getByTestId('ribbon-tab-tableLayout')).toBeVisible()
    await expect(kit.getByTestId('doc-save')).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('doc-embedded.png') })

    // Save goes through Kition's file API (host/write).
    await kit.getByTestId('doc-save').click()
    await expect(kit.getByTestId('doc-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Letter.docx'])
    if (canReadBlobBodies(browserName)) expect(await textOf(saves[0].bytes)).toContain('Bring a tripod.')
  } finally {
    await host.dispose()
  }
})

test('keeps a Doc document’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!existsSync(SDK_WASM) || !existsSync(UI_MARKER), 'the Doc kit editor is not built into public/kits/doc-ui')
  test.skip(!kitPackageHasReplicaInfo('doc', 'kition_doc_sdk'), 'the Doc kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh doc')
  test.setTimeout(180_000)
  const name = 'Replica.docx'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await letterFixture(), {}, { persist: true, modes: { 'kit.doc': 'classic' } })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await kit.getByTestId('doc-canvas-region').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type(' A line added before saving.')
    // The kit applies the keys a moment after they are sent: save once its replica holds still,
    // or keys applied after the save leave the letter unsaved again.
    await expect(kit.getByTestId('doc-unsaved')).toBeVisible()
    let last = ''
    await expect.poll(async () => {
      const now = await replicaVersion(page, name)
      const still = now !== '' && now === last
      last = now
      return still
    }, { timeout: 15_000, intervals: [300] }).toBe(true)
    await kit.getByTestId('doc-save').click()
    await expect(kit.getByTestId('doc-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.doc')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the letter is the replica it was saved with: the same replica version.
    const reopened = await reopen()
    await expect(reopened.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('doc-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) still opens with its stored replica (the file wins
    // where they disagree), recorded as a fresh change: a different version, never the old one.
    await fs.writeFile(path.join(host.root, name), await letterFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
