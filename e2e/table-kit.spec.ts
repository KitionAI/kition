import { expect, test, type FrameLocator, type Page, type Route } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { fulfillJson } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * Kition's tables are `.ktable` files the Table kit edits in its own editor (KitFrame). This gate
 * covers what Kition adds around the kit: creating a table file, saving through Kition's file API,
 * a host feature's write arriving live in an open editor without joining the person's undo, the
 * person's models answering AI fields (`host/generate`), and the host actions a table asks for
 * (`host/action`: `workflow.run`, `design.fromRecord`), and a table file's tables and dashboards
 * in the workspace tree, which open the file in the kit at the one clicked (`document.view`, then
 * `document/reveal`). The editor's own behavior is tested in the kit's repository.
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

type Field = { id: number; name: string; title: string; is_primary?: boolean }
type Record_ = { id: number; values: Record<string, unknown> }

/** A table of leads made by the engine the page runs: a title, an AI tagline, and a workflow button. */
async function leadsFixture() {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Leads.ktable', 0, 0)
  const call = caller(doc)
  const [table] = call<{ tables: Array<{ id: number; fields: Field[] }> }>('documents.get').tables
  call('tables.update', { tableId: table.id, title: 'Leads' })
  for (const field of table.fields.filter((field) => !field.is_primary)) call('fields.delete', { tableId: table.id, fieldId: field.id })
  call('fields.create', { tableId: table.id, title: 'Tagline', type: 'text', options: { ai_config: { type: 'text_generation', prompt: 'Write a tagline', enabled: true } } })
  call('fields.create', { tableId: table.id, title: 'Follow up', type: 'button', options: { label: 'Follow up', action: { kind: 'run_workflow', workflow_id: 7 } } })
  call('records.create', { tableId: table.id, values: { title: 'Ada' } })
  doc.markSaved()
  const bytes = Buffer.from(doc.save())
  doc.free()
  return { bytes, tableId: table.id }
}

/** The records of a saved table file, as the engine reads them. */
async function savedRecords(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.open('Saved.ktable', bytes)
  const call = caller(doc)
  const [table] = call<{ tables: Array<{ id: number }> }>('documents.get').tables
  const records = call<{ items: Record_[] }>('records.list', { tableId: table.id }).items
  doc.free()
  return records
}

/** The person's models, as the settings page stores them. */
async function configureModel(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'kition.desktop.settings.backup.v1',
      JSON.stringify({
        providers: { openai: { enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', wireApi: 'responses', discoveredModels: ['gpt-test'] } },
        models: { activeProvider: 'openai', selectedModelByProvider: { openai: 'gpt-test' } },
      }),
    )
  })
}

/** The table file list host features read (`/v1/kit-tables`): this workspace has none to report. */
async function serveKitTables(page: Page) {
  await page.route(/\/api\/v1\/kit-tables(\?.*)?$/, (route) => fulfillJson(route, { code: 200, message: 'success', data: { files: [] } }))
}

const records = (kit: FrameLocator) => kit.locator('.data-inline-footer')
const stage = (kit: FrameLocator) => kit.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')

/** Opens the record menu on the grid's first row. */
async function recordMenu(kit: FrameLocator) {
  await stage(kit).click({ position: { x: 145, y: 48 } })
  await stage(kit).click({ position: { x: 145, y: 48 }, button: 'right' })
  await expect(kit.getByRole('button', { name: 'Duplicate record' })).toBeVisible()
}

test('the Table kit is packaged with Kition', () => {
  // The gate fails, never skips, when the package is missing: run `make kit-fetch` (or
  // scripts/publish-kit.sh table) to restore public/kits/table-ui.
  expect(engine.built, 'public/kits/table-ui holds the Table kit package').toBe(true)
})

test('creates a table file from the New menu and opens it in the Table kit’s editor', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true, routes: serveKitTables })
  try {
    // On a loaded machine the first-run panel can open after openKitWorkspace dismissed it: once
    // the tree shows, it is up if it is coming, and it would take the new file's tab.
    await expect(page.locator('.document-tree-row').first()).toBeVisible({ timeout: 30_000 })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await expect(page.getByRole('group', { name: 'Data' }).getByTestId('workspace-create-table')).toBeVisible()
    await page.getByTestId('workspace-create-table').click()

    // The page made the file with the kit's engine and wrote it to the workspace…
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled table.ktable'])
    // …then opened it in the kit's editor, with the kit's starter table.
    await expect(page.getByTestId('kit-frame')).toBeVisible({ timeout: 60_000 })
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('ktable-editor')).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('table-title')).toHaveText('Untitled table.ktable')
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled table' })).toBeVisible()
  } finally {
    await host.dispose()
  }
})

test('a host write reaches the open table live, keeps the person’s unsaved edits, and is not the person’s undo', async ({ page, baseURL, browserName }) => {
  test.setTimeout(180_000)
  const { bytes, tableId } = await leadsFixture()
  await configureModel(page)

  // The runtime's bridge requests wait until the test lets them through: a workflow's record.
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let streams = 0
  const posted: Array<Record<string, unknown>> = []
  const generated: Array<Record<string, unknown>> = []
  // Over the workspace mocks: these answers come last.
  const routes = async (page: Page) => {
    await serveKitTables(page)
    await page.route('**/v1/kits/bridge', async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      streams += 1
      if (streams > 1) return route.fulfill({ status: 204, body: '' })
      await released
      const messages = [
        { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 3 } },
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'kit/call',
          params: {
            path: 'Leads.ktable',
            kit: 'kit.table',
            tool: 'run',
            arguments: { steps: [{ command: 'table.records.create', params: { tableId, values: { title: 'From a workflow' }, asOrigin: 'system:workflow' } }], save: false },
          },
        },
      ]
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('') })
    })
    await page.route('**/v1/kits/bridge?**', async (route) => {
      posted.push(route.request().postDataJSON() as Record<string, unknown>)
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    await page.route('**/api/v1/ai/generate', async (route) => {
      generated.push(route.request().postDataJSON() as Record<string, unknown>)
      await fulfillJson(route, { code: 200, message: 'success', data: { text: 'Poetical science', model: 'gpt-test' } })
    })
  }

  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Leads.ktable', bytes, {}, { routes })
  try {
    await expect(records(kit)).toContainText('1 record', { timeout: 60_000 })

    // The person duplicates the record: an unsaved edit of their own.
    await recordMenu(kit)
    await kit.getByRole('button', { name: 'Duplicate record' }).click()
    await expect(records(kit)).toContainText('2 records')
    await expect(kit.getByTestId('table-unsaved')).toBeVisible()

    // A workflow's record arrives through the bridge while the editor is open and unsaved.
    release()
    await expect.poll(() => posted.find((message) => message.id === 1), { timeout: 30_000 }).toBeTruthy()
    const answer = posted.find((message) => message.id === 1)!
    expect(answer.error).toBeUndefined()
    expect(answer.result).toMatchObject({ completed: [{ command: 'table.records.create', changed: true }], saved: false })
    await expect(records(kit)).toContainText('3 records')
    await expect(kit.getByTestId('table-unsaved')).toBeVisible()

    // The person's Undo takes back their own duplicate, never the workflow's record.
    await kit.getByTestId('ktable-toolbar-undo').click()
    await expect(records(kit)).toContainText('2 records')

    // The person's model answers the AI field (host/generate), through the runtime.
    await recordMenu(kit)
    await kit.getByRole('button', { name: 'Regenerate AI fields' }).click()
    await expect.poll(() => generated.length, { timeout: 30_000 }).toBe(1)
    expect(generated[0]).toMatchObject({ purpose: 'ai-field', output: 'text', runtimeModel: expect.objectContaining({ model_name: 'gpt-test', provider_type: 'openai' }) })
    expect(JSON.stringify(generated[0].messages)).toContain('Write a tagline')

    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Leads.ktable'])
    if (canReadBlobBodies(browserName)) {
      const saved = await savedRecords(saves.at(-1)!.bytes)
      expect(saved.map((record) => record.values.title).sort()).toEqual(['Ada', 'From a workflow'])
      expect(saved.find((record) => record.values.title === 'Ada')?.values.tagline).toBe('Poetical science')
    }
  } finally {
    await host.dispose()
  }
})

test('a table’s button runs a Kition workflow, and a record starts a design (host/action)', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { bytes, tableId } = await leadsFixture()
  const runs: Array<{ url: string; body: Record<string, unknown> }> = []
  const routes = async (page: Page) => {
    await serveKitTables(page)
    await page.route('**/api/v1/workflows/*/run-record', async (route) => {
      runs.push({ url: route.request().url(), body: route.request().postDataJSON() as Record<string, unknown> })
      await fulfillJson(route, { code: 200, message: 'success', data: { ok: true } })
    })
  }
  await page.addInitScript(() => {
    const designs: unknown[] = []
    ;(window as unknown as { __designRequests: unknown[] }).__designRequests = designs
    window.addEventListener('kition:design:from-record', (event) => designs.push((event as CustomEvent).detail))
  })

  const { host, kit } = await openInKitFrame(page, baseURL!, 'Leads.ktable', bytes, {}, { routes })
  try {
    await expect(records(kit)).toContainText('1 record', { timeout: 60_000 })

    // The record's panel shows the button; Kition runs the workflow on this file's record.
    await recordMenu(kit)
    await kit.getByRole('button', { name: 'Add comment' }).click()
    await kit.locator('.data-inline-button-cell', { hasText: 'Follow up' }).click()
    await expect.poll(() => runs.length, { timeout: 30_000 }).toBe(1)
    expect(new URL(runs[0].url).pathname).toMatch(/\/workflows\/7\/run-record$/)
    expect(runs[0].body).toEqual({ documentPath: 'Leads.ktable', tableId: String(tableId), recordId: expect.any(String) })
    await page.keyboard.press('Escape')

    // A record's values start a design in Kition.
    await recordMenu(kit)
    await kit.getByRole('button', { name: 'Create design from record' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __designRequests: unknown[] }).__designRequests.length), { timeout: 30_000 }).toBe(1)
    const [design] = await page.evaluate(() => (window as unknown as { __designRequests: Array<{ title: string; fields: Record<string, unknown> }> }).__designRequests)
    expect(design.title).toMatch(/^Design /)
    expect(design.fields).toMatchObject({ title: 'Ada' })
  } finally {
    await host.dispose()
  }
})

/** A table file with two tables and a dashboard, made by the engine the page runs. */
async function baseFixture() {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Base.ktable', 0, 0)
  const call = caller(doc)
  const [first] = call<{ tables: Array<{ id: number }> }>('documents.get').tables
  call('tables.update', { tableId: first.id, title: 'Leads' })
  const people = call<{ id: number }>('tables.create', { title: 'People' })
  call('dashboards.upsert', { dashboardId: 'overview', title: 'Overview', source_table_id: first.id, layout: [], widgets: [] })
  const dashboards = call<{ items: Array<{ id: string }> }>('dashboards.list').items
  doc.markSaved()
  const bytes = Buffer.from(doc.save())
  doc.free()
  return { bytes, leads: first.id, people: people.id, dashboard: dashboards[0].id }
}

test('the tree lists a table file’s tables and dashboards, and opens the file in the kit at the one clicked', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { bytes, leads, people, dashboard } = await baseFixture()
  const described: string[] = []
  // What the runtime answers through the Table kit for the one file the tree reads.
  const routes = async (page: Page) => {
    await serveKitTables(page)
    await page.route(/\/api\/v1\/kit-tables\?path=/, async (route) => {
      described.push(new URL(route.request().url()).searchParams.get('path') ?? '')
      const table = (id: number, title: string) => ({ id: String(id), name: title.toLowerCase(), title, meta: {}, fields: [] })
      await fulfillJson(route, {
        code: 200,
        message: 'success',
        data: { files: [{ path: 'Base.ktable', documentId: null, tables: [table(leads, 'Leads'), table(people, 'People')], dashboards: [{ id: dashboard, name: 'Overview' }] }], unreadable: [] },
      })
    })
  }
  const { host } = await openKitWorkspace(page, baseURL!, { 'Base.ktable': bytes }, { routes })
  try {
    const row = page.locator('.document-tree-row', { hasText: 'Base' }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    // A table file is read for the tree only once it is expanded.
    expect(described).toEqual([])
    await row.locator('.document-tree-lead-toggle').click()
    const child = (title: string) => page.locator('.document-tree-row', { hasText: title }).first()
    await expect(child('People')).toBeVisible()
    await expect(child('Overview')).toBeVisible()
    expect(described).toEqual(['Base.ktable'])

    // The dashboard opens the file in the kit, showing that dashboard.
    await child('Overview').click()
    await expect(page.getByTestId('kit-frame')).toBeVisible({ timeout: 60_000 })
    const kit = page.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kit.getByTestId(`dashboard-tab-${dashboard}`)).toHaveAttribute('aria-current', 'page', { timeout: 60_000 })
    await expect(kit.getByTestId('dashboard-editor-pane')).toBeVisible()

    // Another table of the open file: the open editor shows it.
    await child('People').click()
    await expect(kit.getByTestId(`table-tab-${people}`)).toHaveAttribute('aria-current', 'page')
    await expect(kit.getByTestId('ktable-editor')).toBeVisible()
    await expect(page.getByTestId('kit-frame')).toHaveCount(1)
  } finally {
    await host.dispose()
  }
})
