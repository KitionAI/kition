import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'

type NodeSheetDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ SheetDocument: { create(name: string, width: number, height: number): NodeSheetDocument; open(name: string, bytes: Uint8Array): NodeSheetDocument } }>('sheet', 'kition_sheet_sdk')

/** A real workbook made by the same engine the page runs: a small budget with a total. */
async function budgetFixture() {
  const sdk = await engine.load()
  const doc = sdk.SheetDocument.create('Budget.xlsx', 0, 0)
  for (const [cell, input] of [['A1', 'Item'], ['B1', 'Cost'], ['A2', 'Rent'], ['B2', '1200'], ['A3', 'Food'], ['B3', '450'], ['A4', 'Total'], ['B4', '=SUM(B2:B3)']]) {
    doc.execute('cell.set', JSON.stringify({ cell, input }))
  }
  doc.execute('selection.set', JSON.stringify({ range: 'A1' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

async function cellOf(bytes: Buffer, cell: string) {
  const sdk = await engine.load()
  const doc = sdk.SheetDocument.open('Saved.xlsx', bytes)
  const value = JSON.parse(doc.execute('cell.get', JSON.stringify({ cell }))) as { input?: string; value?: unknown }
  doc.free()
  return value
}

test('opens a workbook in the Sheet kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the Sheet kit editor is not built into public/kits/sheet-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budgetFixture())
  try {
    await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
    await expect(kit.getByTestId('ribbon-tab-home')).toHaveText('Home')
    await expect(kit.getByTestId('sheet-formula')).toHaveValue('Item')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // The Name Box goes to the total; the formula bar shows its formula.
    await kit.getByTestId('sheet-name-box').fill('B4')
    await kit.getByTestId('sheet-name-box').press('Enter')
    await expect(kit.getByTestId('sheet-formula')).toHaveValue('=SUM(B2:B3)')

    // Change the rent from the formula bar, and bold it.
    await kit.getByTestId('sheet-name-box').fill('B2')
    await kit.getByTestId('sheet-name-box').press('Enter')
    await expect(kit.getByTestId('sheet-formula')).toHaveValue('1200')
    await kit.getByTestId('sheet-formula').fill('1300')
    await kit.getByTestId('sheet-formula').press('Enter')
    await expect(kit.getByTestId('sheet-unsaved')).toBeVisible()
    await kit.getByTestId('sheet-cmd-home.bold').click()
    await expect(kit.getByTestId('sheet-cmd-home.bold')).toHaveAttribute('aria-pressed', 'true')

    // A second sheet.
    await kit.getByTestId('sheet-add').click()
    await expect(kit.locator('[data-testid^="sheet-tab-"]')).toHaveCount(2)
    await kit.getByTestId('sheet-tab-Sheet1').click()
    await expect(kit.getByTestId('sheet-status')).toHaveText(/^Sheet1/)
    await page.screenshot({ path: testInfo.outputPath('sheet-embedded.png') })

    await kit.getByTestId('sheet-save').click()
    await expect(kit.getByTestId('sheet-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual(['Budget.xlsx'])
    if (canReadBlobBodies(browserName)) {
      expect((await cellOf(saves[0].bytes, 'B2')).input).toBe('1300')
      expect((await cellOf(saves[0].bytes, 'B4')).value).toBe(1750)
    }
  } finally {
    await host.dispose()
  }
})
