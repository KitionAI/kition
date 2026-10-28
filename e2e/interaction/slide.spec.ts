import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Slide kit (`kit.slide`) in Kition on the desktop host: the host matrix, then the deck's own
 * interactions. The count the matrix follows is the deck's slides. Kition only shows the Slide
 * kit's pinned package here; the kit's own repository is not changed from this suite.
 *
 * Rows not covered here: H11 (printing): the Slide kit's manifest does not ask to print; H13
 * (co-editing) is e2e/collab-slide.spec.ts (`pnpm test:collab:e2e`).
 */

type NodeSlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ SlideDocument: { create(name: string, width: number, height: number): NodeSlideDocument; open(name: string, bytes: Uint8Array): NodeSlideDocument } }>('slide', 'kition_slide_sdk')

/** A title slide and a slide with a square, then `more` slides. */
async function deck(more = 0) {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.create('Launch.kslide', 960, 540)
  doc.execute('slide.new', '{}')
  doc.execute('shape.insert', JSON.stringify({ preset: 'rect', rect: [380, 170, 200, 200] }))
  for (let index = 0; index < more; index += 1) doc.execute('slide.new', '{}')
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

async function slidesOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.open('Saved.kslide', bytes)
  const slides = (JSON.parse(doc.inspect()) as { slides: unknown[] }).slides.length
  doc.free()
  return slides
}

async function shapesOn(bytes: Buffer, index: number) {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.open('Saved.kslide', bytes)
  const slide = JSON.parse(doc.execute('slide.inspect', JSON.stringify({ index }))) as { shapes: Array<{ preset?: string; text?: string }> }
  doc.free()
  return slide.shapes
}

const VIEWPORT = { width: 1600, height: 900 }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/slide-ui holds the Slide kit package').toBe(true)
})

hostMatrix({
  kit: 'slide',
  prefix: 'slides',
  name: 'Launch.kslide',
  title: 'Launch',
  fixture: () => deck(),
  variant: () => deck(2),
  variantCount: 4,
  base: 2,
  viewport: VIEWPORT,
  ready: (kit) => expect(kit.getByTestId('slides-status')).toHaveText(/^Slide \d+ of \d+$/, { timeout: 60_000 }),
  shown: async (kit) => Number(/(\d+)\D*$/.exec((await kit.getByTestId('slides-status').textContent()) ?? '')?.[1] ?? -1),
  saved: slidesOf,
  edit: (kit) => kit.getByTestId('slides-add-slide').click(),
  focus: (kit) => kit.getByTestId('slides-canvas-region').click({ position: { x: 20, y: 20 } }),
  create: { group: 'Visual', name: 'Untitled slide.kslide', count: 1 },
  agent: { command: 'slide.new', params: {} },
  damaged: Buffer.from('this is not a slide file'),
})

test.describe('slide details', () => {
  test.use({ viewport: VIEWPORT })
  test.setTimeout(180_000)

  test('a text box typed on a new slide is saved with its text', tags('slide', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Launch.kslide', await deck(), {}, { persist: true })
    try {
      await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
      await kit.getByTestId('slides-slide-1').click()
      await expect(kit.getByTestId('slides-status')).toHaveText('Slide 2 of 2')
      await kit.getByTestId('slides-tool-textBox').click()
      const canvas = (await kit.getByTestId('slides-canvas-region').boundingBox())!
      await page.mouse.move(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.2)
      await page.mouse.down()
      await page.mouse.move(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.3, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.type('Launch day')
      await page.keyboard.press('Escape')
      await saveNow(kit, 'slides')
      const shapes = await shapesOn(await onDisk(host, 'Launch.kslide'), 1)
      expect(shapes.map((shape) => shape.text ?? '').join('|')).toContain('Launch day')
    } finally {
      await host.dispose()
    }
  })
})
