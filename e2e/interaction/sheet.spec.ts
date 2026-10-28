import { expect, test, type FrameLocator } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { pressCommand } from '../helpers/noteKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Sheet kit (`kit.sheet`) in Kition on the desktop host: the host matrix, then the workbook's
 * own interactions (cells, formulas, rows, sheets, clipboard). The count the matrix follows is the
 * workbook's sheets.
 *
 * Rows not covered here: H11 (printing): the Sheet kit's manifest does not ask to print; H13
 * (co-editing) is e2e/collab-sheet.spec.ts (`pnpm test:collab:e2e`).
 */

type NodeSheetDocument = { save(): Uint8Array; execute(command: string, params: string): string; inspect(): string; free(): void }
const engine = kitEngine<{ SheetDocument: { create(name: string, width: number, height: number): NodeSheetDocument; open(name: string, bytes: Uint8Array): NodeSheetDocument } }>('sheet', 'kition_sheet_sdk')

/** A small budget with a total, and `extraSheets` more sheets. */
async function budget(extraSheets = 0) {
  const sdk = await engine.load()
  const doc = sdk.SheetDocument.create('Budget.xlsx', 0, 0)
  for (const [cell, input] of [['A1', 'Item'], ['B1', 'Cost'], ['A2', 'Rent'], ['B2', '1200'], ['A3', 'Food'], ['B3', '450'], ['A4', 'Total'], ['B4', '=SUM(B2:B3)']]) doc.execute('cell.set', JSON.stringify({ cell, input }))
  for (let index = 0; index < extraSheets; index += 1) doc.execute('home.insertSheet', '{}')
  doc.execute('sheet.activate', JSON.stringify({ index: 0 }))
  doc.execute('selection.set', JSON.stringify({ range: 'A1' }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

async function read<T>(bytes: Buffer, work: (doc: NodeSheetDocument) => T) {
  const sdk = await engine.load()
  const doc = sdk.SheetDocument.open('Saved.xlsx', bytes)
  try {
    return work(doc)
  } finally {
    doc.free()
  }
}

const cellOf = (bytes: Buffer, cell: string) => read(bytes, (doc) => JSON.parse(doc.execute('cell.get', JSON.stringify({ cell }))) as { input?: string; value?: unknown })
const sheetsOf = (bytes: Buffer) => read(bytes, (doc) => (JSON.parse(doc.inspect()) as { sheets: string[] }).sheets.length)

/** Selects `cell` through the name box, and waits until the grid has moved there. */
async function goTo(kit: FrameLocator, cell: string) {
  await kit.getByTestId('sheet-name-box').fill(cell)
  await kit.getByTestId('sheet-name-box').press('Enter')
  await expect(kit.getByTestId('sheet-status')).toHaveText(new RegExp(` · ${cell}$`))
}

/** Gives the keyboard to the grid, as a click on the selected cell does. */
const toGrid = (kit: FrameLocator) => kit.locator('textarea.kui-text-sink').focus()

async function setCell(kit: FrameLocator, cell: string, input: string) {
  await goTo(kit, cell)
  await kit.getByTestId('sheet-formula').fill(input)
  await kit.getByTestId('sheet-formula').press('Enter')
}

const VIEWPORT = { width: 2000, height: 1000 }
const OPTIONS = { modes: { 'kit.sheet': 'classic' as const } }

test.beforeEach(() => {
  expect(engine.built, 'public/kits/sheet-ui holds the Sheet kit package').toBe(true)
})

hostMatrix({
  kit: 'sheet',
  prefix: 'sheet',
  name: 'Budget.xlsx',
  title: 'Budget',
  fixture: () => budget(),
  variant: () => budget(2),
  variantCount: 3,
  base: 1,
  options: OPTIONS,
  viewport: VIEWPORT,
  ready: (kit) => expect(kit.getByTestId('sheet-status')).toHaveText(/^Sheet\d+ · /, { timeout: 60_000 }),
  shown: (kit) => kit.locator('[data-testid^="sheet-tab-"]').count(),
  saved: sheetsOf,
  edit: (kit) => kit.getByTestId('sheet-add').click(),
  focus: (kit) => kit.locator('textarea.kui-text-sink').focus(),
  create: { group: 'Data', name: 'Untitled sheet.xlsx', count: 1 },
  agent: { command: 'home.insertSheet', params: {} },
  damaged: Buffer.from('PK\u0003\u0004 this is not a workbook'),
})

test.describe('sheet details', () => {
  test.use({ viewport: VIEWPORT })
  test.setTimeout(180_000)

  test('a changed cell recalculates its formulas, and the saved workbook holds both', tags('sheet', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budget(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
      await setCell(kit, 'B2', '1300')
      await setCell(kit, 'B5', '=B4*2')
      await goTo(kit, 'B4')
      await expect(kit.getByTestId('sheet-formula')).toHaveValue('=SUM(B2:B3)')
      await saveNow(kit, 'sheet')
      const saved = await onDisk(host, 'Budget.xlsx')
      expect((await cellOf(saved, 'B2')).input).toBe('1300')
      expect((await cellOf(saved, 'B4')).value).toBe(1750)
      expect((await cellOf(saved, 'B5')).value).toBe(3500)
    } finally {
      await host.dispose()
    }
  })

  test('typing into a cell on the grid and pressing Enter stores it and moves down', tags('sheet', [], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budget(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
      await goTo(kit, 'C2')
      await toGrid(kit)
      await page.keyboard.type('Monthly')
      await page.keyboard.press('Enter')
      await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · C3')
      await goTo(kit, 'C2')
      await expect(kit.getByTestId('sheet-formula')).toHaveValue('Monthly')
      await saveNow(kit, 'sheet')
      expect((await cellOf(await onDisk(host, 'Budget.xlsx'), 'C2')).input).toBe('Monthly')
    } finally {
      await host.dispose()
    }
  })

  test('inserting a row above the total keeps the formula pointing at its cells', tags('sheet', [], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budget(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
      await goTo(kit, 'A3')
      await kit.getByRole('button', { name: 'Insert', exact: true }).click()
      await kit.getByTestId('sheet-cmd-home.insertRows').click()
      await goTo(kit, 'B5')
      await expect(kit.getByTestId('sheet-formula')).toHaveValue('=SUM(B2:B4)')
      await setCell(kit, 'B3', '50')
      await saveNow(kit, 'sheet')
      const saved = await onDisk(host, 'Budget.xlsx')
      expect((await cellOf(saved, 'B5')).value).toBe(1700)
      expect((await cellOf(saved, 'A4')).input).toBe('Food')
    } finally {
      await host.dispose()
    }
  })

  test('copy and paste of a cell range through the clipboard', tags('sheet', []), async ({ page, baseURL, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budget(), {}, { persist: true, ...OPTIONS })
    try {
      await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
      await goTo(kit, 'A2:B3')
      await toGrid(kit)
      await pressCommand(page, kit, 'c')
      await goTo(kit, 'D2')
      await toGrid(kit)
      await pressCommand(page, kit, 'v')
      await goTo(kit, 'E3')
      await expect(kit.getByTestId('sheet-formula')).toHaveValue('450', { timeout: 10_000 })
      await saveNow(kit, 'sheet')
      const saved = await onDisk(host, 'Budget.xlsx')
      expect((await cellOf(saved, 'D2')).input).toBe('Rent')
      expect((await cellOf(saved, 'E3')).input).toBe('450')
    } finally {
      await host.dispose()
    }
  })
})
