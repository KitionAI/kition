import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { pressCommand } from '../helpers/noteKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The PDF kit (`kit.pdf`) in Kition on the desktop host: the host matrix, then the PDF's own
 * interactions (pages, bookmarks, find). The count the matrix follows is the PDF's pages.
 *
 * Rows not covered here: H11 (printing): the PDF kit's manifest does not ask to print; H13
 * (co-editing) is e2e/collab-pdf.spec.ts (`pnpm test:collab:e2e`).
 */

type NodePdfDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ PdfDocument: { create(name: string, width: number, height: number): NodePdfDocument; open(name: string, bytes: Uint8Array): NodePdfDocument } }>('pdf', 'kition_pdf_sdk')

/** Two pages of text and a bookmark, then `blank` blank pages. */
async function guide(blank = 0) {
  const sdk = await engine.load()
  const doc = sdk.PdfDocument.create('Guide.pdf', 612, 792)
  doc.execute('page_add_text', JSON.stringify({ page: 1, text: 'Field guide', at: [72, 90], size: 24, width: 468 }))
  doc.execute('page_insert_blank', JSON.stringify({ at: 2 }))
  doc.execute('page_add_text', JSON.stringify({ page: 2, text: 'Green comes from oxygen.', at: [72, 90], size: 12, width: 468 }))
  doc.execute('bookmark_add', JSON.stringify({ page: 2, title: 'Colors' }))
  for (let index = 0; index < blank; index += 1) doc.execute('page_insert_blank', JSON.stringify({ at: 3 + index }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

async function pagesOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.PdfDocument.open('Saved.pdf', bytes)
  const pages = (JSON.parse(doc.inspect()) as { pages: unknown[] }).pages.length
  doc.free()
  return pages
}

const VIEWPORT = { width: 1440, height: 900 }
const OPTIONS = { modes: { 'kit.pdf': 'classic' as const } }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/pdf-ui holds the PDF kit package').toBe(true)
})

hostMatrix({
  kit: 'pdf',
  prefix: 'pdf',
  name: 'Guide.pdf',
  title: 'Guide',
  fixture: () => guide(),
  variant: () => guide(2),
  variantCount: 4,
  base: 2,
  options: OPTIONS,
  viewport: VIEWPORT,
  ready: (kit) => expect(kit.getByTestId('pdf-status')).toHaveText(/^Page \d+ of \d+$/, { timeout: 60_000 }),
  shown: async (kit) => Number(/(\d+)\D*$/.exec((await kit.getByTestId('pdf-status').textContent()) ?? '')?.[1] ?? -1),
  saved: pagesOf,
  edit: (kit) => kit.getByTestId('pdf-insert-page').click(),
  focus: (kit) => kit.getByTestId('pdf-canvas-region').click({ position: { x: 300, y: 200 } }),
  create: { group: 'Documents', name: 'Untitled PDF.pdf', count: 1 },
  agent: { command: 'page_insert_blank', params: { at: 1 } },
  damaged: Buffer.from('this is not a PDF file at all'),
})

test.describe('pdf details', () => {
  test.use({ viewport: VIEWPORT })
  test.setTimeout(180_000)

  test('a bookmark goes to its page, and find goes to the match', tags('pdf', []), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Guide.pdf', await guide(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
      await kit.getByTestId('pdf-panel-bookmarks').click()
      await kit.getByTestId('pdf-bookmark').click()
      await expect(kit.getByTestId('pdf-status')).toHaveText('Page 2 of 2')
      await kit.getByTestId('pdf-panel-pages').click()
      await kit.getByTestId('pdf-thumb-0').click()
      await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2')
      await pressCommand(page, kit, 'f')
      await kit.getByTestId('pdf-find-text').fill('oxygen')
      await expect(kit.getByTestId('pdf-find-count')).toHaveText('1/1')
      await expect(kit.getByTestId('pdf-status')).toHaveText('Page 2 of 2')
    } finally {
      await host.dispose()
    }
  })

  test('a deleted page comes back with Undo, and a duplicated one is saved', tags('pdf', ['H4'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Guide.pdf', await guide(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
      await kit.getByTestId('pdf-delete-page').click()
      await expect(kit.getByTestId('pdf-status')).toHaveText(/of 1$/)
      await kit.getByTestId('pdf-undo').click()
      await expect(kit.getByTestId('pdf-status')).toHaveText(/of 2$/)
      await kit.getByTestId('pdf-duplicate-page').click()
      await expect(kit.getByTestId('pdf-status')).toHaveText(/of 3$/)
      await saveNow(kit, 'pdf')
      expect(await pagesOf(await onDisk(host, 'Guide.pdf'))).toBe(3)
    } finally {
      await host.dispose()
    }
  })
})
