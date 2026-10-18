import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'
import { fulfillJson } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * The Table kit (`kit.table`), which Kition does not use for its own tables: a development build
 * opens `.kitable` files in it when this flag is set (`tableKitForDevelopment` in kitEditors.ts).
 */
const TABLE_KIT_DEV_FLAG = 'kition.dev.tableKit'
/** Set in the tab's session storage, the next load opens tables natively again. */
const NATIVE_MARK = 'e2e.table-embedded.native'

type NodeTableDocument = { call(method: string, params: string): string; save(): Uint8Array; free(): void }
type TableSdk = {
  TableDocument: { create(name: string, width: number, height: number): NodeTableDocument; open(name: string, bytes: Uint8Array): NodeTableDocument }
  tableMethods(): string
}
const engine = kitEngine<TableSdk>('table', 'kition_table_sdk')

function call<T>(doc: NodeTableDocument, method: string, params: Record<string, unknown> = {}) {
  return (JSON.parse(doc.call(method, JSON.stringify(params))) as { result: T }).result
}

type Table = { id: number; primary_field_id: number; fields: Array<{ id: number; name: string }> }

/** The first table's id and its primary field's name. */
function firstTable(doc: NodeTableDocument) {
  const table = call<{ tables: Table[] }>(doc, 'documents.get').tables[0]
  return { id: table.id, primary: table.fields.find((field) => field.id === table.primary_field_id)!.name }
}

/** A real table made by the engine the page runs (Kition's own kition-kitable): two tasks. */
async function tasksFixture() {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Tasks.kitable', 0, 0)
  const table = firstTable(doc)
  for (const title of ['Write the brief', 'Plan the launch']) call(doc, 'records.create', { tableId: table.id, values: { [table.primary]: title } })
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

async function titlesOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.open('Tasks.kitable', bytes)
  const table = firstTable(doc)
  const titles = call<{ items: Array<{ values: Record<string, unknown> }> }>(doc, 'records.list', { tableId: table.id }).items.map((record) => record.values[table.primary])
  doc.free()
  return titles
}

/** A 1x1 PNG. */
const PICTURE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** A table whose record has a picture the file holds as a blob (`attachments.put`); answers its bytes and the blob's hash. */
async function photoFixture() {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Photos.kitable', 0, 0)
  const table = firstTable(doc)
  const record = call<{ id: number }>(doc, 'records.create', { tableId: table.id, values: { [table.primary]: 'Beach' } })
  const field = call<{ name: string }>(doc, 'fields.create', { tableId: table.id, title: 'Photo', type: 'attachment' })
  const attachment = call<{ url: string }>(doc, 'attachments.put', { tableId: table.id, name: 'beach.png', mimeType: 'image/png', data: PICTURE })
  call(doc, 'records.update', { tableId: table.id, recordId: record.id, values: { [field.name]: [attachment] } })
  const bytes = doc.save()
  doc.free()
  return { bytes: Buffer.from(bytes), hash: attachment.url.replace(/^kition-blob:/, '') }
}

/**
 * Opens tables in the kit until the tab is marked native (`NATIVE_MARK`), and records the text
 * the grids draw (`__tableTextDraws`) and every URL an image loads (`__imageLoads`), in every frame.
 */
async function openTablesInKitUntilNative(page: Page) {
  await page.addInitScript(
    ({ flag, mark }) => {
      if (window.sessionStorage.getItem(mark)) window.localStorage.removeItem(flag)
      else window.localStorage.setItem(flag, '1')
      const draws: string[] = []
      ;(window as typeof window & { __tableTextDraws?: string[] }).__tableTextDraws = draws
      const fillText = CanvasRenderingContext2D.prototype.fillText
      CanvasRenderingContext2D.prototype.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
        draws.push(String(text))
        return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth)
      }
      const loads: string[] = []
      ;(window as typeof window & { __imageLoads?: string[] }).__imageLoads = loads
      const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      if (source?.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          ...source,
          set(value: string) {
            if (value) loads.push(String(value))
            source.set!.call(this, value)
          },
        })
      }
    },
    { flag: TABLE_KIT_DEV_FLAG, mark: NATIVE_MARK },
  )
}

/**
 * Kition's data-document HTTP API for `name`, answered by the kit's engine over the file in the
 * workspace: the same `kition-table-api` requests the runtime's routes run, so Kition's native
 * table editor opens what the kit saved as the runtime would show it. A blob's bytes are sent as
 * the response body, as the runtime's route sends them; `blobReads` records the hashes asked for.
 */
async function answerDataDocumentsFromFile(page: Page, root: string, name: string, blobReads: string[] = []) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.open(name, await fs.readFile(path.join(root, name)))
  const base = '/api/v1/data-documents'
  const routes = (JSON.parse(sdk.tableMethods()) as Array<[string, string]>).map(([method, route]) => {
    const [verb, template] = route.split(' ')
    const names: string[] = []
    const pattern = template.replace(/\{(\w+)\}/g, (_, key: string) => {
      names.push(key)
      return '([^/]+)'
    })
    return { method, verb, names, pattern: new RegExp(`^${base}/\\d+${pattern === '' ? '' : pattern}$`) }
  })
  const document = () => ({ ...call<Record<string, unknown>>(doc, 'documents.get'), path: name })
  await page.route(`**${base}**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === base && request.method() === 'GET') return fulfillJson(route, { code: 200, data: { items: [document()], total: 1, offset: 0 } })
    if (url.pathname === `${base}/open` || (url.pathname === `${base}/1` && request.method() === 'GET')) return fulfillJson(route, { code: 200, data: document() })
    for (const { method, verb, names, pattern } of routes) {
      const match = request.method() === verb ? pattern.exec(url.pathname) : null
      if (!match) continue
      const params: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...((request.postDataJSON() as Record<string, unknown> | null) ?? {}) }
      names.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1])
      })
      try {
        if (method === 'attachments.read') {
          blobReads.push(String(params.hash))
          const blob = call<{ data: string; mimeType: string }>(doc, method, params)
          return route.fulfill({ status: 200, contentType: blob.mimeType, body: Buffer.from(blob.data, 'base64') })
        }
        return fulfillJson(route, { code: 200, message: 'success', data: call(doc, method, params) })
      } catch (error) {
        return fulfillJson(route, { code: 400, message: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
    return route.fallback()
  })
}

test('opens a table in the Table kit, edits a cell there, saves it, and Kition opens the saved file natively', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!engine.built, 'the Table kit is not built into public/kits/table-ui (scripts/build-kit-ui.sh table)')
  test.setTimeout(180_000)
  // The kit opens tables until the test marks the tab native; the grids' text is recorded as drawn.
  await openTablesInKitUntilNative(page)
  const name = 'Tasks.kitable'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, name, await tasksFixture(), {}, { persist: true })
  try {
    // Kition's own table editor, inside the kit's frame, over the kit's engine.
    await expect(kit.getByTestId('kitable-editor')).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('table-title')).toHaveText(name)
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)
    await expect(kit.getByText('2 records')).toBeVisible()

    // The first task's title, edited in the grid.
    const grid = kit.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
    await expect(grid).toBeVisible()
    await grid.click({ position: { x: 145, y: 48 } })
    await grid.dblclick({ position: { x: 145, y: 48 } })
    const cell = kit.locator('.data-inline-grid-canvas input.cursor-text')
    await expect(cell).toBeFocused()
    await cell.fill('Edited in the kit')
    await cell.press('Enter')
    await expect(kit.getByTestId('table-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('table-embedded.png') })

    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual([name])
    if (canReadBlobBodies(browserName)) expect(await titlesOf(saves[0].bytes)).toEqual(['Edited in the kit', 'Plan the launch'])

    // Reopened without the kit: Kition's native table editor shows the saved file.
    await answerDataDocumentsFromFile(page, host.root, name)
    await page.evaluate((mark) => window.sessionStorage.setItem(mark, '1'), NATIVE_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Tasks' }).first().click()
    await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('kit-frame')).toHaveCount(0)
    await expect(page.getByText('2 records')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __tableTextDraws?: string[] }).__tableTextDraws ?? []), { timeout: 15_000 }).toContain('Edited in the kit')
    await page.screenshot({ path: testInfo.outputPath('table-native.png') })
  } finally {
    await host.dispose()
  }
})

test('shows a picture the file holds as a blob, in the Table kit and in Kition natively', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Table kit is not built into public/kits/table-ui (scripts/build-kit-ui.sh table)')
  test.setTimeout(180_000)
  await openTablesInKitUntilNative(page)
  const name = 'Photos.kitable'
  const { bytes, hash } = await photoFixture()
  const { host, kit } = await openInKitFrame(page, baseURL!, name, bytes, {}, { persist: true })
  try {
    // The kit reads the picture's bytes from its engine and draws it from an object URL.
    await expect(kit.getByTestId('kitable-editor')).toBeVisible({ timeout: 60_000 })
    const frame = () => page.frames().find((candidate) => candidate.url().includes('/kits/table-ui/'))
    await expect
      .poll(async () => (await frame()?.evaluate(() => (window as typeof window & { __imageLoads?: string[] }).__imageLoads ?? [])) ?? [], { timeout: 30_000 })
      .toContainEqual(expect.stringMatching(/^blob:/))
    await page.screenshot({ path: testInfo.outputPath('table-embedded-blob.png') })

    // Kition's native editor loads the same picture from the runtime's blob route.
    const blobReads: string[] = []
    await answerDataDocumentsFromFile(page, host.root, name, blobReads)
    await page.evaluate((mark) => window.sessionStorage.setItem(mark, '1'), NATIVE_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Photos' }).first().click()
    await expect(page.getByTestId('kitable-editor')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('kit-frame')).toHaveCount(0)
    await expect.poll(() => blobReads, { timeout: 30_000 }).toContain(hash)
    await expect
      .poll(() => page.evaluate(() => (window as typeof window & { __imageLoads?: string[] }).__imageLoads ?? []), { timeout: 15_000 })
      .toContainEqual(expect.stringContaining(`/api/v1/data-documents/1/blobs/${hash}`))
    await page.screenshot({ path: testInfo.outputPath('table-native-blob.png') })
  } finally {
    await host.dispose()
  }
})
