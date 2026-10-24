import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type EngineDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
type SlideSdk = { SlideDocument: { create(name: string, width: number, height: number): EngineDocument } }

const slides = kitEngine<SlideSdk>('slide', 'kition_slide_sdk')
const PATH = 'Review.kitionslide'

/** A slide file of two slides. */
async function slideFixture() {
  const sdk = await slides.load()
  const doc = sdk.SlideDocument.create(PATH, 960, 540)
  doc.execute('slide.new', JSON.stringify({ layout: 'titleAndContent', title: 'quarterly business review', body: 'revenue grew in the north' }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** A workspace script that sets the second slide's title to `title` through the object model. */
function retitleScript(title: string) {
  return `export default async function (ctx) {
  await ctx.document.run(async (context) => {
    context.root.slides.load()
    await context.sync()
    const slide = context.root.slides.at(1)
    slide.shapes.load()
    await context.sync()
    const shape = slide.shapes.at(0)
    shape.load(['body'])
    await context.sync()
    const body = context.object(shape.body, 'TextBody')
    body.paragraphs.load()
    await context.sync()
    body.paragraphs.at(0).text = ${JSON.stringify(title)}
  })
}
`
}

async function runScript(page: Page, script: string) {
  await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null
    focused?.blur()
    if (document.activeElement !== document.body) {
      document.body.tabIndex = -1
      document.body.focus()
    }
  })
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  const row = page.locator('[data-testid="command-palette-row"][data-command="run-script"]')
  await expect(row).toBeVisible({ timeout: 15_000 })
  // The palette may still be settling when the row is clicked; the click that opens the dialog counts.
  await row.click({ timeout: 10_000 }).catch(async (error: unknown) => {
    if (!(await page.getByTestId('run-script-dialog').isVisible())) throw error
  })
  await expect(page.getByTestId('run-script-dialog')).toBeVisible()
  await page.getByTestId('run-script-path').fill(`scripts/${script}`)
  await page.getByTestId('run-script-run').click()
  await expect(page.getByText(`Ran ${script}`).last()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('run-script-dialog')).toHaveCount(0)
}

/** Every slide's title, as the open editor's object model reads them. */
async function titles(page: Page) {
  await runScript(page, 'titles.mjs')
  const text = await page.getByText(/^\{"titles":/).last().textContent()
  return (JSON.parse(text ?? '{}') as { titles: string[] }).titles
}

async function setReadOnly(page: Page, kit: FrameLocator, readOnly: boolean) {
  const opening = page.getByTestId('kit-opening')
  await page.evaluate(({ path, readOnly }) => window.__KITION_KIT_TEST__!.setReadOnlyDocuments(readOnly ? [path] : []), { path: PATH, readOnly })
  await expect(opening).toBeVisible({ timeout: 30_000 })
  await expect(opening).toHaveCount(0, { timeout: 60_000 })
  await expect(kit.getByTestId('slides-status')).toBeVisible({ timeout: 60_000 })
}

const TITLES_SCRIPT = `export default async function (ctx) {
  return ctx.document.run(async (context) => {
    const slides = context.root.slides
    slides.load()
    await context.sync()
    const titles = []
    for (const slide of slides.items) {
      slide.shapes.load()
      await context.sync()
      let title = ''
      for (const shape of slide.shapes.items) shape.load(['props', 'body'])
      await context.sync()
      for (const shape of slide.shapes.items) {
        if (!['title', 'ctrTitle'].includes(shape.props?.ph?.kind) || !shape.body) continue
        const body = context.object(shape.body, 'TextBody')
        body.paragraphs.load()
        await context.sync()
        for (const paragraph of body.paragraphs.items) paragraph.load(['text'])
        await context.sync()
        title = body.paragraphs.items.map((paragraph) => String(paragraph.text)).join(' ')
      }
      titles.push(title)
    }
    return { titles }
  })
}
`

// The workspace keeps no saved file here (no `persist`): a saved replica no longer matches its
// file, and a slide file never saved has none. Either way the editor a role change opens again has
// another replica than the one it replaces, and must still show the slide file once, with every edit.
for (const saved of [true, false]) {
  test(`keeps a slide file's slides once, with its unsaved edits, when a role change opens its editor again (${saved ? 'a saved replica the file lacks' : 'no saved replica'})`, async ({ page, baseURL }) => {
    test.skip(!slides.built, 'the Slide kit editor is not built into public/kits/slide-ui')
    test.setTimeout(180_000)
    const { host, kit } = await openInKitFrame(page, baseURL!, PATH, await slideFixture(), {
      'scripts/first.mjs': Buffer.from(retitleScript('first edit')),
      'scripts/second.mjs': Buffer.from(retitleScript('second edit')),
      'scripts/titles.mjs': Buffer.from(TITLES_SCRIPT),
    })
    try {
      await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
      await expect(page.getByTestId('kit-opening')).toHaveCount(0)
      await runScript(page, 'first.mjs')
      if (saved) {
        await expect(kit.getByTestId('slides-unsaved')).toBeVisible({ timeout: 15_000 })
        await kit.getByTestId('slides-save').click()
        await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
      }
      await runScript(page, 'second.mjs')
      const before = await titles(page)
      expect(before[1]).toBe('second edit')

      // Twice each way: an editor opened again must not leave the next one another replica either.
      for (const readOnly of [true, false, true, false]) {
        await setReadOnly(page, kit, readOnly)
        await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
        await expect(page.locator('[data-testid="kit-frame"][data-active="true"]').getByRole('alert')).toHaveCount(0)
        // Scripts run on editable documents only.
        if (!readOnly) expect(await titles(page)).toEqual(before)
      }
    } finally {
      await host.dispose()
    }
  })
}
