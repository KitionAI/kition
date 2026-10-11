import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
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

test('opens a PDF in the PDF kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the PDF kit editor is not built into public/kits/pdf-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Guide.pdf', await guideFixture())
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
