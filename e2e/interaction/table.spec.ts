import { expect, test, type FrameLocator } from '@playwright/test'
import { kitEngine, openInKitFrame } from '../helpers/embeddedKit'
import { hostMatrix, onDisk, saveNow } from './helpers-a'
import { tags } from './support'

/**
 * The Table kit (`kit.table`) in Kition on the desktop host: the host matrix, then the table's own
 * interactions. The count the matrix follows is the first table's records; a person adds one by
 * duplicating a record from its menu. The table gates (`pnpm test:table:e2e`,
 * `pnpm test:ktable:e2e`) and the kit's own repository cover the grid in depth.
 *
 * Rows not covered here: H10 (version history): the Table kit keeps no replica, which Kition's
 * version history needs; H11 (printing): the Table kit's manifest does not ask to print.
 *
 * H13 (co-editing): the Table kit's editor does not offer its replica yet. Turned on for a trial,
 * a shared table could not be opened (`kition_table_sdk cannot open a replica`), so co-editing
 * stays off until its engine opens a replica.
 */

type NodeTableDocument = { call(method: string, params: string): string; save(): Uint8Array; markSaved(): void; free(): void }
const engine = kitEngine<{ TableDocument: { create(name: string, width: number, height: number): NodeTableDocument; open(name: string, bytes: Uint8Array): NodeTableDocument } }>('table', 'kition_table_sdk')

function caller(doc: NodeTableDocument) {
  return <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): T => {
    const answer = JSON.parse(doc.call(method, JSON.stringify(params))) as { result?: T; error?: unknown }
    if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error)}`)
    return answer.result as T
  }
}

/** A table of leads with `count` records; answers its bytes and the table's id. */
async function leads(count = 1) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Leads.ktable', 0, 0)
  const call = caller(doc)
  const [table] = call<{ tables: Array<{ id: number }> }>('documents.get').tables
  call('tables.update', { tableId: table.id, title: 'Leads' })
  const names = ['Ada', 'Grace', 'Edsger', 'Barbara']
  for (let index = 0; index < count; index += 1) call('records.create', { tableId: table.id, values: { title: names[index] } })
  doc.markSaved()
  const bytes = Buffer.from(doc.save())
  doc.free()
  return { bytes, tableId: table.id }
}

async function recordsOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.open('Saved.ktable', bytes)
  const call = caller(doc)
  const [table] = call<{ tables: Array<{ id: number }> }>('documents.get').tables
  const items = call<{ items: Array<{ values: Record<string, unknown> }> }>('records.list', { tableId: table.id }).items
  doc.free()
  return items
}

const footer = (kit: FrameLocator) => kit.locator('.data-inline-footer')
const stage = (kit: FrameLocator) => kit.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')

/** Duplicates the grid's first record from its menu. */
async function duplicateFirst(kit: FrameLocator) {
  await stage(kit).click({ position: { x: 145, y: 48 } })
  await stage(kit).click({ position: { x: 145, y: 48 }, button: 'right' })
  await kit.getByRole('button', { name: 'Duplicate record' }).click()
}

/** A new table file's first table: the engine numbers it 1. */
const FIRST_TABLE = 1

test.beforeEach(() => {
  expect(engine.built, 'public/kits/table-ui holds the Table kit package').toBe(true)
})

hostMatrix({
  kit: 'table',
  prefix: 'table',
  name: 'Leads.ktable',
  title: 'Leads',
  fixture: async () => (await leads(1)).bytes,
  variant: async () => (await leads(3)).bytes,
  variantCount: 3,
  base: 1,
  ready: (kit) => expect(kit.getByTestId('ktable-editor')).toBeVisible({ timeout: 60_000 }).then(() => expect(footer(kit)).toContainText(/\d+ records?/, { timeout: 60_000 })),
  shown: async (kit) => Number(/(\d+) records?/.exec((await footer(kit).textContent()) ?? '')?.[1] ?? -1),
  saved: async (bytes) => (await recordsOf(bytes)).length,
  edit: duplicateFirst,
  // Not a cell: a click on the selected cell edits it, and an open cell editor keeps Cmd+S.
  focus: (kit) => kit.getByTestId('table-title').click(),
  // The Table kit keeps no replica, so Kition keeps no version history of its files (H10).
  history: false,
  undo: (kit) => kit.getByTestId('ktable-toolbar-undo').click(),
  redo: (kit) => kit.getByTestId('ktable-toolbar-redo').click(),
  create: { group: 'Data', name: 'Untitled table.ktable', count: 0 },
  agent: { command: 'table.records.create', params: { tableId: FIRST_TABLE, values: { title: 'From the agent' } } },
  damaged: Buffer.from('this is not a table file'),
})

test.describe('table details', () => {
  test.setTimeout(180_000)

  test('a record deleted from its menu is gone from the saved file', tags('table', ['H3'], true), async ({ page, baseURL }) => {
    const { host, kit } = await openInKitFrame(page, baseURL!, 'Leads.ktable', (await leads(2)).bytes, {}, { persist: true })
    try {
      await expect(footer(kit)).toContainText('2 records', { timeout: 60_000 })
      await stage(kit).click({ position: { x: 145, y: 48 } })
      await stage(kit).click({ position: { x: 145, y: 48 }, button: 'right' })
      await kit.getByRole('button', { name: 'Delete record' }).click()
      await expect(footer(kit)).toContainText('Showing 1–1')
      await saveNow(kit, 'table')
      const saved = await recordsOf(await onDisk(host, 'Leads.ktable'))
      expect(saved).toHaveLength(1)
    } finally {
      await host.dispose()
    }
  })
})
