import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'

type SlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
type SlideSdk = { SlideDocument: { create(name: string, width: number, height: number): SlideDocument; open(name: string, bytes: Uint8Array): SlideDocument } }

const slides = kitEngine<SlideSdk>('slide', 'kition_slide_sdk')
const EXAMPLE = path.join(process.cwd(), 'e2e', 'fixtures', 'extensions', 'title-case')
const EXTENSION = 'com.kition.examples.title-case'
const READ_ONLY = 'com.kition.examples.title-case-read-only'

/** A deck whose second slide has a title in lower case. */
async function deckFixture() {
  const sdk = await slides.load()
  const doc = sdk.SlideDocument.create('Review.kitionslide', 960, 540)
  doc.execute('slide.new', JSON.stringify({ layout: 'titleAndContent', title: 'quarterly business review', body: 'revenue grew in the north' }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** The texts of slide `index` of a saved deck. */
async function slideTexts(bytes: Buffer, index: number) {
  const sdk = await slides.load()
  const doc = sdk.SlideDocument.open('Saved.kitionslide', bytes)
  const text = doc.execute('slide.inspect', JSON.stringify({ index }))
  doc.free()
  return text
}

async function openPalette(page: Page) {
  // Focus Kition itself (not the kit's frame, which keeps its own keys) and open the palette.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
}

async function runPaletteCommand(page: Page, key: string, screenshot?: string) {
  await openPalette(page)
  const row = page.locator(`[data-testid="command-palette-row"][data-command="${key}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  if (screenshot) await page.screenshot({ path: screenshot })
  await row.click()
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

async function installExtension(page: Page, workspacePath: string, id: string, screenshot?: string) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kition:settings:open', { detail: { section: 'extensions' } })))
  await expect(page.getByTestId('extensions-settings')).toBeVisible()
  await page.getByTestId('extensions-install-path').fill(workspacePath)
  await page.getByTestId('extensions-install').click()
  await expect(page.locator(`[data-testid="extension-row"][data-extension="${id}"]`)).toHaveAttribute('data-enabled', 'true')
  if (screenshot) await page.screenshot({ path: screenshot })
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('extensions-settings')).toHaveCount(0)
}

async function save(kit: FrameLocator) {
  await expect(kit.getByTestId('slides-unsaved')).toBeVisible({ timeout: 15_000 })
  await kit.getByTestId('slides-save').click()
  await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
}

test('installs an extension, runs its command and a workspace script on a Slides deck, and refuses one without model.write', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!slides.built, 'the Slides kit editor is not built into public/kits/slide-ui')
  test.setTimeout(180_000)
  const example = {
    manifest: await fs.readFile(path.join(EXAMPLE, 'extension.json'), 'utf8'),
    source: await fs.readFile(path.join(EXAMPLE, 'extension.mjs')),
  }
  // The same code, declared without model.write.
  const readOnly = JSON.parse(example.manifest) as { id: string; name: string; permissions: string[]; contributes: { commands: Array<{ title: string }> } }
  readOnly.id = READ_ONLY
  readOnly.name = 'Title case (read only)'
  readOnly.permissions = ['model.read']
  readOnly.contributes.commands[0].title = 'Title case without write permission'
  const script = `// Replaces the body text of the second slide through the object model.
export default async function (ctx) {
  return ctx.document.run(async (context) => {
    context.root.slides.load()
    await context.sync()
    const slide = context.root.slides.at(1)
    slide.shapes.load()
    await context.sync()
    const content = slide.shapes.at(1)
    content.load(['body'])
    await context.sync()
    const body = context.object(content.body, 'TextBody')
    body.paragraphs.load()
    await context.sync()
    body.paragraphs.at(0).text = 'Agenda from a script'
    return { slides: context.root.slides.length }
  })
}
`
  const files = {
    'extensions/title-case/extension.json': Buffer.from(example.manifest),
    'extensions/title-case/extension.mjs': example.source,
    'extensions/read-only/extension.json': Buffer.from(JSON.stringify(readOnly, null, 2)),
    'extensions/read-only/extension.mjs': example.source,
    'scripts/agenda.mjs': Buffer.from(script),
  }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Review.kitionslide', await deckFixture(), files)
  try {
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    await installExtension(page, 'extensions/title-case', EXTENSION)
    await installExtension(page, 'extensions/read-only/extension.json', READ_ONLY, testInfo.outputPath('extensions-settings.png'))

    // Without model.write the extension's edit is refused, and the deck stays as it was.
    await runPaletteCommand(page, `extension:${READ_ONLY}:titleCase.apply`, testInfo.outputPath('extensions-palette.png'))
    await expect(page.getByText('Title case without write permission failed')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/does not have the model\.write permission/)).toBeVisible()
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
    // Its sandbox is a scripts-only frame on an opaque origin.
    await expect(page.locator(`iframe[data-kition-extension="${READ_ONLY}"]`)).toHaveAttribute('sandbox', 'allow-scripts')

    // The example extension title-cases the deck's titles; the deck saves with them.
    await runPaletteCommand(page, `extension:${EXTENSION}:titleCase.apply`)
    await expect(page.getByText('Title-cased 1 title')).toBeVisible({ timeout: 30_000 })
    await save(kit)
    expect(saves.map((saved) => saved.path)).toEqual(['Review.kitionslide'])
    if (canReadBlobBodies(browserName)) {
      const texts = await slideTexts(saves[0].bytes, 1)
      expect(texts).toContain('Quarterly Business Review')
      expect(texts).toContain('revenue grew in the north')
    }

    // A workspace script runs against the same deck.
    await runPaletteCommand(page, 'run-script')
    await expect(page.getByTestId('run-script-dialog')).toBeVisible()
    await page.getByTestId('run-script-path').fill('scripts/agenda.mjs')
    await page.getByTestId('run-script-run').click()
    await expect(page.getByText('Ran agenda.mjs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('run-script-dialog')).toHaveCount(0)
    await save(kit)
    expect(saves.map((saved) => saved.path)).toEqual(['Review.kitionslide', 'Review.kitionslide'])
    if (canReadBlobBodies(browserName)) {
      const texts = await slideTexts(saves[1].bytes, 1)
      expect(texts).toContain('Agenda from a script')
      expect(texts).not.toContain('revenue grew in the north')
      expect(texts).toContain('Quarterly Business Review')
    }
  } finally {
    await host.dispose()
  }
})
