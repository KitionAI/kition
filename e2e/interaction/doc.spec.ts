import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { pressCommand } from '../helpers/noteKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Doc kit (`kit.doc`) in Kition on the desktop host: the host matrix, then the document's own
 * interactions (typing, formatting, tables, find). The count the matrix follows is the document's
 * pages; a person adds one with a page break (Cmd+Enter).
 *
 * Rows not covered here: H11 (printing): the Doc kit's manifest does not ask to print; H13
 * (co-editing) is e2e/collab-doc.spec.ts (`pnpm test:collab:e2e`).
 */

type NodeDocDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ DocDocument: { create(name: string, width: number, height: number): NodeDocDocument; open(name: string, bytes: Uint8Array): NodeDocDocument } }>('doc', 'kition_doc_sdk')

/** A title and a paragraph, then `breaks` page breaks. */
async function letter(breaks = 0) {
  const sdk = await engine.load()
  const doc = sdk.DocDocument.create('Letter.docx', 612, 792)
  doc.execute('para.style', JSON.stringify({ style: 'Title' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Field notes' }))
  doc.execute('text.newParagraph', '{}')
  doc.execute('para.style', JSON.stringify({ style: 'Normal' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Auroras appear near the poles.' }))
  for (let index = 0; index < breaks; index += 1) doc.execute('text.pageBreak', '{}')
  doc.execute('caret.docStart', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

async function read<T>(bytes: Buffer, work: (doc: NodeDocDocument) => T) {
  const sdk = await engine.load()
  const doc = sdk.DocDocument.open('Saved.docx', bytes)
  try {
    return work(doc)
  } finally {
    doc.free()
  }
}

const pagesOf = (bytes: Buffer) => read(bytes, (doc) => (JSON.parse(doc.inspect()) as { pages: unknown[] }).pages.length)
const textOf = (bytes: Buffer) => read(bytes, (doc) => (JSON.parse(doc.execute('document.text', '{}')) as { text: string }).text)

/** Puts the caret at the end of the document, as a click on the page and Cmd+Down do. */
async function toEnd(kit: FrameLocator, page: Page) {
  await kit.getByTestId('doc-canvas-region').click({ position: { x: 400, y: 300 } })
  await pressCommand(page, kit, 'End')
  await pressCommand(page, kit, 'ArrowDown')
}

const VIEWPORT = { width: 1920, height: 1000 }
const OPTIONS = { modes: { 'kit.doc': 'classic' as const } }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/doc-ui holds the Doc kit package').toBe(true)
})

hostMatrix({
  kit: 'doc',
  prefix: 'doc',
  name: 'Letter.docx',
  title: 'Letter',
  fixture: () => letter(),
  variant: () => letter(2),
  variantCount: 3,
  base: 1,
  options: OPTIONS,
  viewport: VIEWPORT,
  ready: (kit) => expect(kit.getByTestId('doc-status')).toHaveText(/^Page \d+ of \d+$/, { timeout: 60_000 }),
  shown: async (kit) => Number(/of (\d+)$/.exec((await kit.getByTestId('doc-status').textContent()) ?? '')?.[1] ?? -1),
  saved: pagesOf,
  edit: async (kit, page) => {
    await toEnd(kit, page)
    await pressCommand(page, kit, 'Enter')
  },
  focus: (kit) => kit.getByTestId('doc-canvas-region').click({ position: { x: 400, y: 300 } }),
  create: { group: 'Documents', name: 'Untitled doc.docx', count: 1 },
  agent: { command: 'text.pageBreak', params: {} },
  damaged: Buffer.from('PK\u0003\u0004 this is not a document'),
})

test.describe('doc details', () => {
  test.use({ viewport: VIEWPORT })
  test.setTimeout(180_000)

  test('typed text, bold, and a table reach the saved document', tags('doc', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Letter.docx', await letter(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
      await toEnd(kit, page)
      await page.keyboard.type(' Bring a tripod.')
      await pressCommand(page, kit, 'b')
      await page.keyboard.type(' Dress warmly.')
      await expect(kit.getByTestId('doc-cmd-format.bold')).toHaveAttribute('aria-pressed', 'true')
      await kit.getByTestId('ribbon-tab-insert').click()
      await kit.getByTestId('doc-table').click()
      await kit.getByTestId('kui-table-2x2').click()
      await expect(kit.getByTestId('ribbon-tab-tableLayout')).toBeVisible()
      await saveNow(kit, 'doc')
      const saved = await onDisk(host, 'Letter.docx')
      const text = await textOf(saved)
      expect(text).toContain('Auroras appear near the poles. Bring a tripod. Dress warmly.')
    } finally {
      await host.dispose()
    }
  })

  test('undo takes a typed word back in one step, and the file is untouched until Save', tags('doc', ['H4'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Letter.docx', await letter(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
      const before = await onDisk(host, 'Letter.docx')
      await toEnd(kit, page)
      await page.keyboard.type(' Oops')
      await expect(kit.getByTestId('doc-unsaved')).toBeVisible()
      // A typed word is one step to undo, as in Word.
      await kit.getByTestId('doc-undo').click()
      expect((await onDisk(host, 'Letter.docx')).equals(before)).toBe(true)
      await page.keyboard.type(' Kept.')
      await saveNow(kit, 'doc')
      const text = await textOf(await onDisk(host, 'Letter.docx'))
      expect(text).toContain('poles. Kept.')
      expect(text).not.toContain('Oops')
    } finally {
      await host.dispose()
    }
  })
})
