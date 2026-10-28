import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The HTML kit (`kit.html`) in Kition on the desktop host: the host matrix, then the page's own
 * interactions (source, preview). The count the matrix follows is the page's paragraphs; a person
 * adds one in the source. e2e/html-embedded.spec.ts covers the preview's scripts and canvas.
 *
 * Rows not covered here: H8 (a damaged file): any bytes are HTML source, so there is no damaged
 * HTML file; H11 (printing): the HTML kit's manifest does not ask to print; H13 (co-editing):
 * Kition has no co-editing spec for the HTML kit yet.
 */

const engine = kitEngine('html', 'kition_html_sdk')

const htmlPage = (count: number) => `<!doctype html><html><body><h1>Notes</h1>${Array.from({ length: count }, (_, index) => `<p>Line ${index + 1}</p>`).join('')}</body></html>`
const paragraphs = (source: string) => (source.match(/<p>/g) ?? []).length

test.beforeEach(() => {
  expect(engine.built, 'public/kits/html-ui holds the HTML kit package').toBe(true)
})

hostMatrix({
  kit: 'html',
  prefix: 'html',
  name: 'Notes.html',
  title: 'Notes',
  fixture: async () => Buffer.from(htmlPage(1)),
  variant: async () => Buffer.from(htmlPage(3)),
  variantCount: 3,
  base: 1,
  ready: (kit) => expect(kit.getByTestId('html-source')).toHaveValue(/<html/i, { timeout: 60_000 }),
  shown: async (kit) => paragraphs(await kit.getByTestId('html-source').inputValue()),
  saved: async (bytes) => paragraphs(bytes.toString('utf8')),
  edit: async (kit) => {
    const source = kit.getByTestId('html-source')
    const value = await source.inputValue()
    await source.fill(value.replace('</body>', `<p>Line ${paragraphs(value) + 1}</p></body>`))
  },
  focus: (kit) => kit.getByTestId('html-source').click(),
  conflict: { bar: 'html-conflict', keep: 'html-keep-mine', reload: 'html-reload' },
  create: { group: 'Documents', name: 'Untitled HTML.html', count: 0 },
  agent: { command: 'html.setSource', params: { source: htmlPage(2) } },
})

test.describe('html details', () => {
  test.setTimeout(180_000)

  test('the preview follows the source, and only the source is saved', tags('html', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Notes.html', Buffer.from(htmlPage(1)), {}, { persist: true })
    try {
      const source = kit.getByTestId('html-source')
      await expect(source).toHaveValue(/<h1>Notes<\/h1>/, { timeout: 60_000 })
      await expect(kit.getByTestId('html-preview').locator('canvas').first()).toBeVisible({ timeout: 30_000 })
      const edited = htmlPage(1).replace('<h1>Notes</h1>', '<h1 style="color:#5645d4">Edited notes</h1>')
      await source.fill(edited)
      await expect(kit.getByTestId('html-unsaved')).toBeVisible()
      await saveNow(kit, 'html')
      expect((await onDisk(host, 'Notes.html')).toString('utf8')).toBe(edited)
    } finally {
      await host.dispose()
    }
  })
})
