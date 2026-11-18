import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Layout kit (`kit.layout`) in Kition on the desktop host: the host matrix, then the layout's
 * own interactions (pages, layers). The count the matrix follows is the layout's pages.
 *
 * Rows not covered here: H10 (version history): the Layout kit keeps no replica, which Kition's
 * version history needs; H11 (printing): the Layout kit's manifest does not ask to print.
 *
 * H13 (co-editing): the Layout kit's editor does not offer its replica yet. Turned on for a trial,
 * an edit made in each window while one was offline merged into duplicated pages: both windows
 * converged on 8 pages, numbered 1 to 4 twice, where 5 were made. Co-editing stays off until the
 * kit's merge keeps each page once.
 */

type NodeLayoutDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ LayoutDocument: { create(name: string, width: number, height: number): NodeLayoutDocument; open(name: string, bytes: Uint8Array): NodeLayoutDocument } }>('layout', 'kition_layout_kit')

/** One page with a text frame, then `pages` more pages. */
async function flyer(pages = 0) {
  const sdk = await engine.load()
  const doc = sdk.LayoutDocument.create('Flyer.klayout', 612, 792)
  doc.execute('frame.create', JSON.stringify({ rect: [54, 72, 558, 200], content: 'text', caret: true }))
  doc.execute('text.insert', JSON.stringify({ text: 'Spring concert' }))
  doc.execute('text.exitToFrame', '{}')
  doc.execute('edit.deselectAll', '{}')
  for (let index = 0; index < pages; index += 1) doc.execute('layout.pages.insert', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

async function inspected(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.LayoutDocument.open('Saved.klayout', bytes)
  const info = JSON.parse(doc.inspect()) as { pageCount: number; layers: unknown[] }
  doc.free()
  return info
}

const OPTIONS = { modes: { 'kit.layout': 'menus' as const } }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/layout-ui holds the Layout kit package').toBe(true)
})

hostMatrix({
  kit: 'layout',
  prefix: 'layout',
  name: 'Flyer.klayout',
  title: 'Flyer',
  fixture: () => flyer(),
  variant: () => flyer(2),
  variantCount: 3,
  base: 1,
  options: OPTIONS,
  ready: (kit) => expect(kit.getByTestId('layout-status')).toHaveText(/^\d+ pages?$/, { timeout: 60_000 }),
  shown: async (kit) => Number(/(\d+)/.exec((await kit.getByTestId('layout-status').textContent()) ?? '')?.[1] ?? -1),
  saved: async (bytes) => (await inspected(bytes)).pageCount,
  edit: (kit) => kit.getByTestId('layout-add-page').click(),
  // The Layout kit keeps no replica, so Kition keeps no version history of its files (H10).
  history: false,
  focus: (kit) => kit.getByTestId('layout-canvas-region').click({ position: { x: 40, y: 40 } }),
  create: { group: 'Documents', name: 'Untitled layout.klayout', count: 1 },
  agent: { command: 'layout.pages.insert', params: {} },
  damaged: Buffer.from('this is not a layout'),
})

test.describe('layout details', () => {
  test.setTimeout(180_000)

  test('a new layer and a deleted page reach the saved layout', tags('layout', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Flyer.klayout', await flyer(1), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('layout-status')).toHaveText('2 pages', { timeout: 60_000 })
      await kit.getByTestId('layout-new-layer').click()
      await expect(kit.getByTestId('layout-layers').getByText('Layer 2')).toBeVisible()
      await kit.getByTestId('layout-delete-page').click()
      await expect(kit.getByTestId('layout-status')).toHaveText('1 page')
      await saveNow(kit, 'layout')
      const saved = await inspected(await onDisk(host, 'Flyer.klayout'))
      expect(saved.pageCount).toBe(1)
      expect(saved.layers).toHaveLength(2)
    } finally {
      await host.dispose()
    }
  })
})
