import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

type Doc = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ DocDocument: { create(name: string, width: number, height: number): Doc } }>('doc', 'kition_doc_sdk')

test.use({ viewport: { width: 1440, height: 900 } })

test('document scrollbars navigate multiple pages without editing the file', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const sdk = await engine.load()
  const document = sdk.DocDocument.create('Pages.docx', 612, 792)
  for (let index = 1; index <= 3; index += 1) {
    if (index > 1) document.execute('text.pageBreak', '{}')
    document.execute('text.insert', JSON.stringify({ text: `Page ${index}` }))
  }
  document.execute('caret.docStart', '{}')
  const bytes = Buffer.from(document.save())
  document.free()
  const { host, kit, saves } = await openInKitFrame(page, baseURL!, 'Pages.docx', bytes)
  try {
    await expect(kit.getByTestId('doc-status')).toHaveText('Page 1 of 3', { timeout: 30_000 })
    const scrollbar = kit.getByRole('scrollbar', { name: 'Vertical document scroll' })
    await expect(scrollbar).toBeVisible()
    const value = async () => Number(await scrollbar.getAttribute('aria-valuenow'))
    const max = async () => Number(await scrollbar.getAttribute('aria-valuemax'))
    await expect.poll(max).toBeGreaterThan(1000)
    await expect.poll(value).toBeLessThan(1)
    await kit.getByTestId('kit-canvas-surface').hover()
    await page.mouse.wheel(0, 350)
    await expect.poll(value).toBeGreaterThan(100)
    const track = await scrollbar.boundingBox()
    const thumb = await scrollbar.locator('.kui-scrollbar-thumb').boundingBox()
    expect(track).not.toBeNull()
    expect(thumb).not.toBeNull()
    expect(thumb!.height).toBeLessThan(track!.height / 2)
    await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb!.x + thumb!.width / 2, track!.y + track!.height + thumb!.height, { steps: 10 })
    await page.mouse.up()
    await expect.poll(async () => Math.abs(await value() - await max())).toBeLessThan(1)
    await page.screenshot({ path: testInfo.outputPath('document-scrollbar-bottom.png') })
    await scrollbar.press('Home')
    await expect.poll(value).toBeLessThan(1)
    await expect(kit.getByTestId('kit-zoom')).toHaveText('133%')
    await expect(kit.getByTestId('doc-unsaved')).toHaveCount(0)
    expect(saves).toHaveLength(0)
  } finally {
    await host.dispose()
  }
})
