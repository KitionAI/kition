import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'

type EngineDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
type SlideSdk = { SlideDocument: { create(name: string, width: number, height: number): EngineDocument; open(name: string, bytes: Uint8Array): EngineDocument } }

const slides = kitEngine<SlideSdk>('slide', 'kition_slide_sdk')
const words = kitEngine<{ DocDocument: { create(name: string, width: number, height: number): EngineDocument } }>('doc', 'kition_doc_sdk')
const sheets = kitEngine<{ SheetDocument: { create(name: string, width: number, height: number): EngineDocument } }>('sheet', 'kition_sheet_sdk')
const EXAMPLE = path.join(process.cwd(), 'e2e', 'fixtures', 'extensions', 'title-case')
const EXTENSION = 'com.kition.examples.title-case'
const READ_ONLY = 'com.kition.examples.title-case-read-only'
const PANEL = 'titleCase.titles'

/** The example extension's files, as a workspace folder `folder`. */
async function exampleFiles(folder: string) {
  return Object.fromEntries(await Promise.all(['extension.json', 'extension.mjs', 'panel.html'].map(async (name) => [`${folder}/${name}`, await fs.readFile(path.join(EXAMPLE, name))] as const)))
}

/** A slide file whose second slide has a title in lower case. */
async function slideFixture() {
  const sdk = await slides.load()
  const doc = sdk.SlideDocument.create('Review.kslide', 960, 540)
  doc.execute('slide.new', JSON.stringify({ layout: 'titleAndContent', title: 'quarterly business review', body: 'revenue grew in the north' }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** The texts of slide `index` of a saved slide file. */
async function slideTexts(bytes: Buffer, index: number) {
  const sdk = await slides.load()
  const doc = sdk.SlideDocument.open('Saved.kslide', bytes)
  const text = doc.execute('slide.inspect', JSON.stringify({ index }))
  doc.free()
  return text
}

async function openPalette(page: Page) {
  // Focus Kition itself (not the kit's frame, which keeps its own keys) and open the palette.
  // WebKit keeps keyboard focus in a frame whose element is blurred, so focus the page's body.
  // A kit editor that finishes loading can take the focus back into its frame, where Cmd+K is
  // the kit's own; focus Kition and press again until the palette shows.
  await expect(async () => {
    await page.evaluate(() => {
      const focused = document.activeElement as HTMLElement | null
      focused?.blur()
      if (document.activeElement !== document.body) {
        document.body.tabIndex = -1
        document.body.focus()
      }
    })
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
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

test('installs an extension, runs its command and a workspace script on a slide file, and refuses one without model.write', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!slides.built, 'the Slide kit editor is not built into public/kits/slide-ui')
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
    ...(await exampleFiles('extensions/title-case')),
    ...(await exampleFiles('extensions/read-only')),
    'extensions/read-only/extension.json': Buffer.from(JSON.stringify(readOnly, null, 2)),
    'scripts/agenda.mjs': Buffer.from(script),
  }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Review.kslide', await slideFixture(), files)
  try {
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    await installExtension(page, 'extensions/title-case', EXTENSION)
    await installExtension(page, 'extensions/read-only/extension.json', READ_ONLY, testInfo.outputPath('extensions-settings.png'))

    // Without model.write the extension's edit is refused, and the slide file stays as it was.
    await runPaletteCommand(page, `extension:${READ_ONLY}:titleCase.apply`, testInfo.outputPath('extensions-palette.png'))
    await expect(page.getByText('Title case without write permission failed')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/does not have the model\.write permission/)).toBeVisible()
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0)
    // Its sandbox is a scripts-only frame on an opaque origin.
    await expect(page.locator(`iframe[data-kition-extension="${READ_ONLY}"]`)).toHaveAttribute('sandbox', 'allow-scripts')

    // The example extension title-cases the slide file's titles; the slide file saves with them.
    await runPaletteCommand(page, `extension:${EXTENSION}:titleCase.apply`)
    await expect(page.getByText('Title-cased 1 title')).toBeVisible({ timeout: 30_000 })
    await save(kit)
    expect(saves.map((saved) => saved.path)).toEqual(['Review.kslide'])
    if (canReadBlobBodies(browserName)) {
      const texts = await slideTexts(saves[0].bytes, 1)
      expect(texts).toContain('Quarterly Business Review')
      expect(texts).toContain('revenue grew in the north')
    }

    // A workspace script runs against the same slide file.
    await runPaletteCommand(page, 'run-script')
    await expect(page.getByTestId('run-script-dialog')).toBeVisible()
    await page.getByTestId('run-script-path').fill('scripts/agenda.mjs')
    await page.getByTestId('run-script-run').click()
    await expect(page.getByText('Ran agenda.mjs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('run-script-dialog')).toHaveCount(0)
    await save(kit)
    expect(saves.map((saved) => saved.path)).toEqual(['Review.kslide', 'Review.kslide'])
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

test("shows an extension's panel beside the Slide editor, whose button title-cases the slide file; Cmd+. opens the palette from inside the kit, whose Cmd+K stays its own", async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!slides.built, 'the Slide kit editor is not built into public/kits/slide-ui')
  test.setTimeout(180_000)
  const retitle = `// Sets the second slide's title through the object model.
export default async function (ctx) {
  await ctx.document.run(async (context) => {
    context.root.slides.load()
    await context.sync()
    const slide = context.root.slides.at(1)
    slide.shapes.load()
    await context.sync()
    const title = slide.shapes.at(0)
    title.load(['body'])
    await context.sync()
    const body = context.object(title.body, 'TextBody')
    body.paragraphs.load()
    await context.sync()
    body.paragraphs.at(0).text = 'agenda for the review'
  })
}
`
  // Saves reach the workspace, so the editor a role change opens again finds the saved replica.
  const { host, saves, kit } = await openInKitFrame(
    page,
    baseURL!,
    'Review.kslide',
    await slideFixture(),
    { ...(await exampleFiles('extensions/title-case')), 'scripts/retitle.mjs': Buffer.from(retitle) },
    { persist: true },
  )
  try {
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)
    await installExtension(page, 'extensions/title-case', EXTENSION)

    // The page's own platform decides Cmd or Ctrl (the Chromium project emulates Windows).
    const mod = (await page.evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))) ? 'Meta' : 'Control'
    // Inside the kit, Cmd+K is the kit's (Slide inserts a link with it): Kition's palette stays shut.
    await kit.getByTestId('slides-status').click()
    await page.keyboard.press(`${mod}+k`)
    await page.waitForTimeout(500)
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Cmd+. reaches Kition's palette from inside the kit.
    await kit.getByTestId('slides-status').click()
    await page.keyboard.press(`${mod}+.`)
    await expect(page.getByTestId('command-palette')).toBeVisible()
    const row = page.locator(`[data-testid="command-palette-row"][data-command="panel:${EXTENSION}:${PANEL}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toContainText('Show panel: Slide titles')
    await row.click()
    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    // The panel sits beside the editor, in a scripts-only frame, and lists the slide file's titles.
    const aside = page.getByTestId('extension-panel')
    await expect(aside).toBeVisible()
    await expect(aside).toHaveAttribute('data-extension', EXTENSION)
    await expect(page.getByTestId('extension-panel-title')).toHaveText('Slide titles')
    const frame = page.locator(`iframe[data-kition-panel="${EXTENSION}:${PANEL}"]`)
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    const panel = page.frameLocator(`iframe[data-kition-panel="${EXTENSION}:${PANEL}"]`)
    await expect(panel.locator('.item')).toHaveText(['2quarterly business review'], { timeout: 30_000 })
    const editor = await page.locator('[data-testid="kit-frame"][data-active="true"]').boundingBox()
    const side = await aside.boundingBox()
    expect(side!.x).toBeGreaterThanOrEqual(editor!.x + editor!.width - 1)
    await page.screenshot({ path: testInfo.outputPath('extension-panel.png') })

    // Its button title-cases the slide file through the extension; the list follows.
    await panel.getByRole('button', { name: 'Title case' }).click()
    await expect(panel.getByRole('status')).toHaveText('Title-cased 1 title', { timeout: 30_000 })
    await expect(panel.locator('.item')).toHaveText(['2Quarterly Business Review'])
    await save(kit)
    if (canReadBlobBodies(browserName)) expect(await slideTexts(saves[0].bytes, 1)).toContain('Quarterly Business Review')

    // Another change to the slide file (a script's) reaches the panel.
    await runPaletteCommand(page, 'run-script')
    await page.getByTestId('run-script-path').fill('scripts/retitle.mjs')
    await page.getByTestId('run-script-run').click()
    await expect(page.getByText('Ran retitle.mjs')).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.item')).toHaveText(['2agenda for the review'], { timeout: 30_000 })

    // A role change opens the editor again, read-only and then editable, with the unsaved edits
    // (the saved file's replica, then the script's change): the panel opens again on each new
    // editor by itself, lists its titles, and its button works on the editable one.
    const title = '2agenda for the review'
    for (const readOnly of [true, false]) {
      const before = await aside.getAttribute('data-editor-opening')
      await page.evaluate(({ path, readOnly }) => window.__KITION_KIT_TEST__!.setReadOnlyDocuments(readOnly ? [path] : []), { path: 'Review.kslide', readOnly })
      await expect(aside).not.toHaveAttribute('data-editor-opening', before ?? '', { timeout: 60_000 })
      await expect(aside).not.toHaveAttribute('data-editor-opening', '', { timeout: 60_000 })
      await expect(aside).toHaveAttribute('data-status', 'open', { timeout: 60_000 })
      await expect(panel.locator('.item')).toHaveText([title], { timeout: 30_000 })
    }
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await panel.getByRole('button', { name: 'Title case' }).click()
    await expect(panel.getByRole('status')).toHaveText('Title-cased 1 title', { timeout: 30_000 })
    await expect(panel.locator('.item')).toHaveText(['2Agenda for the Review'])

    // Closed, it is gone from the layout.
    await page.getByTestId('extension-panel-close').click()
    await expect(page.getByTestId('extension-panel')).toHaveCount(0)
    await expect(frame).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('runs a workspace script on a Word document and on a workbook through their object models', async ({ page, baseURL }) => {
  test.skip(!words.built || !sheets.built, 'the Word and Sheet kit editors are not built into public/kits')
  test.setTimeout(180_000)
  const word = (await words.load()).DocDocument.create('Notes.docx', 612, 792)
  word.execute('text.insert', JSON.stringify({ text: 'first draft' }))
  const notes = Buffer.from(word.save())
  word.free()
  const sheet = (await sheets.load()).SheetDocument.create('Budget.xlsx', 0, 0)
  sheet.execute('cell.set', JSON.stringify({ cell: 'B2', input: '1200' }))
  const budget = Buffer.from(sheet.save())
  sheet.free()
  const docScript = `// Prefixes the first paragraph, then reads it back.
export default async function (ctx) {
  return ctx.document.run(async (context) => {
    const body = context.root.body.load()
    await context.sync()
    const first = body.at(0)
    first.text.insert(0, 'Reviewed: ')
    first.load(['text'])
    await context.sync()
    return { kit: ctx.document.kitId, text: first.text.toString() }
  })
}
`
  const sheetScript = `// Doubles B2 into B3 with a kit command and renames the sheet, then reads both back.
export default async function (ctx) {
  return ctx.document.run(async (context) => {
    context.commands.run('cell.set', { cell: 'B3', input: '=B2*2' })
    const sheets = context.root.sheets.load()
    await context.sync()
    sheets.at(0).name = 'Totals'
    const cell = context.commands.run('cell.get', { cell: 'B3' })
    sheets.at(0).load(['name'])
    await context.sync()
    return { kit: ctx.document.kitId, sheet: sheets.at(0).name, b3: cell.value.value }
  })
}
`
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Notes.docx', notes, {
    'Budget.xlsx': budget,
    'scripts/word.mjs': Buffer.from(docScript),
    'scripts/sheet.mjs': Buffer.from(sheetScript),
  })
  try {
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    await runPaletteCommand(page, 'run-script')
    await page.getByTestId('run-script-path').fill('scripts/word.mjs')
    await page.getByTestId('run-script-run').click()
    await expect(page.getByText('Ran word.mjs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('{"kit":"kit.doc","text":"Reviewed: first draft"}')).toBeVisible()
    await expect(kit.getByTestId('doc-unsaved')).toBeVisible()

    // A second kit tab: its frame is the one titled with its path.
    await page.locator('.document-tree-row', { hasText: 'Budget' }).first().click()
    const budgetKit = page.frameLocator('iframe[title="Budget.xlsx"]')
    await expect(budgetKit.getByTestId('sheet-status')).toHaveText(/^Sheet1 · /, { timeout: 60_000 })
    await runPaletteCommand(page, 'run-script')
    await page.getByTestId('run-script-path').fill('scripts/sheet.mjs')
    await page.getByTestId('run-script-run').click()
    await expect(page.getByText('Ran sheet.mjs')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('{"kit":"kit.sheet","sheet":"Totals","b3":2400}')).toBeVisible()
    await expect(budgetKit.getByTestId('sheet-status')).toHaveText(/^Totals · /)
  } finally {
    await host.dispose()
  }
})
