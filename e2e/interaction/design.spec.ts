import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Design kit (`kit.design`) in Kition on the desktop host: the host matrix, then the layout's
 * own interactions (pages, layers). The count the matrix follows is the layout's pages.
 *
 * Rows not covered here: H10 (version history): the Design kit keeps no replica, which Kition's
 * version history needs; H11 (printing): the Design kit's manifest does not ask to print.
 *
 * H13 (co-editing): the Design kit's editor does not offer its replica yet. Turned on for a trial,
 * an edit made in each window while one was offline merged into duplicated pages: both windows
 * converged on 8 pages, numbered 1 to 4 twice, where 5 were made. Co-editing stays off until the
 * kit's merge keeps each page once.
 */

type NodeDesignDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ DesignDocument: { create(name: string, width: number, height: number): NodeDesignDocument; open(name: string, bytes: Uint8Array): NodeDesignDocument } }>('design', 'kition_design_sdk')

/** One page with a text frame, then `pages` more pages. */
async function flyer(pages = 0) {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Flyer.kdesign', 612, 792)
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
  const doc = sdk.DesignDocument.open('Saved.kdesign', bytes)
  const info = JSON.parse(doc.inspect()) as { pageCount: number; layers: unknown[] }
  doc.free()
  return info
}

const OPTIONS = { modes: { 'kit.design': 'menus' as const } }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/design-ui holds the Design kit package').toBe(true)
})

hostMatrix({
  kit: 'design',
  prefix: 'design',
  name: 'Flyer.kdesign',
  title: 'Flyer',
  fixture: () => flyer(),
  variant: () => flyer(2),
  variantCount: 3,
  base: 1,
  options: OPTIONS,
  ready: (kit) => expect(kit.getByTestId('design-status')).toHaveText(/^\d+ pages?$/, { timeout: 60_000 }),
  shown: async (kit) => Number(/(\d+)/.exec((await kit.getByTestId('design-status').textContent()) ?? '')?.[1] ?? -1),
  saved: async (bytes) => (await inspected(bytes)).pageCount,
  edit: (kit) => kit.getByTestId('design-add-page').click(),
  // The Design kit keeps no replica, so Kition keeps no version history of its files (H10).
  history: false,
  focus: (kit) => kit.getByTestId('design-canvas-region').click({ position: { x: 40, y: 40 } }),
  create: { group: 'Documents', name: 'Untitled design.kdesign', count: 1 },
  agent: { command: 'layout.pages.insert', params: {} },
  damaged: Buffer.from('this is not a layout'),
})

test.describe('design details', () => {
  test.setTimeout(180_000)

  test('a new layer and a deleted page reach the saved layout', tags('design', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Flyer.kdesign', await flyer(1), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('design-status')).toHaveText('2 pages', { timeout: 60_000 })
      await kit.getByTestId('design-new-layer').click()
      await expect(kit.getByTestId('design-layers').getByText('Layer 2')).toBeVisible()
      await kit.getByTestId('design-delete-page').click()
      await expect(kit.getByTestId('design-status')).toHaveText('1 page')
      await saveNow(kit, 'design')
      const saved = await inspected(await onDisk(host, 'Flyer.kdesign'))
      expect(saved.pageCount).toBe(1)
      expect(saved.layers).toHaveLength(2)
    } finally {
      await host.dispose()
    }
  })
})
