import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion } from './helpers/embeddedKit'
import { kitPackageHasReplicaInfo } from './helpers/kitionPro'
import { dismissFirstRunActivation } from './helpers/onboarding'
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

// The tests click the Classic ribbon, which needs a wide window (Home: about 1680 px beside the sidebar); a narrower one steps down to Single line.
test.use({ viewport: { width: 2000, height: 1000 } })

test('opens a workbook in the Sheet kit’s own editor, edits it there, and saves it through Kition', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the Sheet kit editor is not built into public/kits/sheet-ui')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budgetFixture(), {}, { modes: { 'kit.sheet': 'classic' } })
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

test('keeps a workbook’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Sheet kit editor is not built into public/kits/sheet-ui')
  test.skip(!kitPackageHasReplicaInfo('sheet', 'kition_sheet_sdk'), 'the Sheet kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh sheet')
  test.setTimeout(180_000)
  const name = 'Replica.xlsx'
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await budgetFixture(), {}, { persist: true, modes: { 'kit.sheet': 'classic' } })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
    // A second sheet and a new rent: changes both the file and the replica keep.
    await kit.getByTestId('sheet-name-box').fill('B2')
    await kit.getByTestId('sheet-name-box').press('Enter')
    await kit.getByTestId('sheet-formula').fill('1300')
    await kit.getByTestId('sheet-formula').press('Enter')
    await kit.getByTestId('sheet-add').click()
    await expect(kit.locator('[data-testid^="sheet-tab-"]')).toHaveCount(2)
    await kit.getByTestId('sheet-save').click()
    await expect(kit.getByTestId('sheet-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.sheet')
    // The replica's blobs, one content-addressed file each.
    expect((await fs.stat(path.join(store, docId, 'blobs'))).isDirectory()).toBe(true)
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the workbook is the replica it was saved with: the second sheet and the new rent
    // survive, and opening records nothing (the file is what the replica saves).
    const reopened = await reopen()
    await expect(reopened.locator('[data-testid^="sheet-tab-"]')).toHaveCount(2, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('sheet-unsaved')).toHaveCount(0)
    await reopened.getByTestId('sheet-tab-Sheet1').click()
    await reopened.getByTestId('sheet-name-box').fill('B2')
    await reopened.getByTestId('sheet-name-box').press('Enter')
    await expect(reopened.getByTestId('sheet-formula')).toHaveValue('1300')

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await budgetFixture())
    const changed = await reopen()
    await expect(changed.locator('[data-testid^="sheet-tab-"]')).toHaveCount(1, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
