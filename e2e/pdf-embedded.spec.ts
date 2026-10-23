import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

type NodePdfDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ PdfDocument: { create(name: string, width: number, height: number): NodePdfDocument; open(name: string, bytes: Uint8Array): NodePdfDocument } }>('pdf', 'kition_pdf_sdk')

/** A real PDF made by the same engine the page runs: two pages of text and a bookmark. */
async function guideFixture() {
  const sdk = await engine.load()
  const doc = sdk.PdfDocument.create('Guide.pdf', 612, 792)
  doc.execute('page_add_text', JSON.stringify({ page: 1, text: 'Field guide', at: [72, 90], size: 24, width: 468 }))
  doc.execute('page_insert_blank', JSON.stringify({ at: 2 }))
  doc.execute('page_add_text', JSON.stringify({ page: 2, text: 'Green comes from oxygen.', at: [72, 90], size: 12, width: 468 }))
  doc.execute('bookmark_add', JSON.stringify({ page: 2, title: 'Colors' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

async function pagesOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.PdfDocument.open('Saved.pdf', bytes)
  const pages = (JSON.parse(doc.inspect()) as { pages: unknown[] }).pages.length
  doc.free()
  return pages
}

// The tests click the Classic ribbon, which needs a wide window (Home: about 1030 px beside the sidebar); a narrower one steps down to Single line.
test.use({ viewport: { width: 1440, height: 900 } })

test('opens a PDF in the PDF kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the PDF kit editor is not built into public/kits/pdf-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Guide.pdf', await guideFixture(), {}, { modes: { 'kit.pdf': 'classic' } })
  try {
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // The bookmark goes to page 2; a blank page goes after it.
    await kit.getByTestId('pdf-panel-bookmarks').click()
    await kit.getByTestId('pdf-bookmark').click()
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 2 of 2')
    await kit.getByTestId('pdf-insert-page').click()
    await expect(kit.getByTestId('pdf-status')).toHaveText(/of 3$/)
    await expect(kit.getByTestId('pdf-unsaved')).toBeVisible()

    // Find goes back to the match.
    await kit.getByTestId('pdf-panel-pages').click()
    await kit.getByTestId('pdf-thumb-0').click()
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 3')
    await kit.getByTestId('pdf-thumb-0').press('ControlOrMeta+f')
    await kit.getByTestId('pdf-find-text').fill('oxygen')
    await expect(kit.getByTestId('pdf-find-count')).toHaveText('1/1')
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 2 of 3')
    await page.screenshot({ path: testInfo.outputPath('pdf-embedded.png') })

    await kit.getByTestId('pdf-save').click()
    await expect(kit.getByTestId('pdf-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Guide.pdf'])
    if (canReadBlobBodies(browserName)) expect(await pagesOf(saves[0].bytes)).toBe(3)
  } finally {
    await host.dispose()
  }
})

test('keeps a PDF’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the PDF kit editor is not built into public/kits/pdf-ui')
  test.skip(!kitPackageHasReplicaInfo('pdf', 'kition_pdf_sdk'), 'the PDF kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh pdf')
  test.setTimeout(180_000)
  const name = 'Replica.pdf'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await guideFixture(), {}, { persist: true, modes: { 'kit.pdf': 'classic' } })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
    await kit.getByTestId('pdf-insert-page').click()
    await expect(kit.getByTestId('pdf-status')).toHaveText(/of 3$/)
    await kit.getByTestId('pdf-save').click()
    await expect(kit.getByTestId('pdf-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.pdf')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the PDF is the replica it was saved with: the third page survives, nothing unsaved.
    const reopened = await reopen()
    await expect(reopened.getByTestId('pdf-status')).toHaveText(/of 3$/, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('pdf-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await guideFixture())
    const changed = await reopen()
    await expect(changed.getByTestId('pdf-status')).toHaveText(/of 2$/, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
