import { expect, test, type FrameLocator, type Page, type Route } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { fulfillJson } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * Kition's tables are `.ktable` files the Table kit edits in its own editor (KitFrame). This gate
 * covers what Kition adds around the kit: creating a table file, saving through Kition's file API,
 * a host feature's write arriving live in an open editor without joining the person's undo, the
 * person's models answering AI fields and selection rewrites (`host/generate`), the host actions a table offers
 * (`host/action`: none besides Settings), and a table file's tables and dashboards
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

/** A table of leads made by the engine the page runs: a title and an AI tagline. */
async function leadsFixture() {
  const sdk = await engine.load()
  const doc = sdk.TableDocument.create('Leads.ktable', 0, 0)
  const call = caller(doc)
  const [table] = call<{ tables: Array<{ id: number; fields: Field[] }> }>('documents.get').tables
  call('tables.update', { tableId: table.id, title: 'Leads' })
  for (const field of table.fields.filter((field) => !field.is_primary)) call('fields.delete', { tableId: table.id, fieldId: field.id })
  call('fields.create', { tableId: table.id, title: 'Tagline', type: 'text', options: { ai_config: { type: 'text_generation', prompt: 'Write a tagline', enabled: true } } })
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
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible({ timeout: 60_000 })
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('ktable-editor')).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('table-title')).toHaveText('Untitled table.ktable')
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled table' })).toBeVisible()
  } finally {
    await host.dispose()
  }
})

test('creates a second table and opens it through a valid desktop file signature', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { bytes } = await leadsFixture()
  const token = 'k'.repeat(64)
  const reads: string[] = []
  const routes = async (page: Page) => {
    await serveKitTables(page)
    // The runtime checks signed paths before considering a token header.
    await page.route(/\/_signed\/.*\/workspace-files\//, async (route) => {
      const match = /^\/_signed\/(\d+)\.(\d+)\.([0-9a-f]+)(\/.*)$/.exec(new URL(route.request().url()).pathname)
      if (!match) return route.fulfill({ status: 401 })
      const [, expires, length, signature, target] = match
      const expected = createHmac('sha256', token).update(`${expires}\n${target.slice(0, Number(length))}`).digest('hex')
      if (signature !== expected || Number(expires) < Date.now() / 1000) return route.fulfill({ status: 401 })
      if (route.request().method() === 'GET') reads.push(decodeURIComponent(target))
      return route.fallback()
    })
  }
  const { host, saves } = await openKitWorkspace(page, baseURL!, { 'Untitled table.ktable': bytes }, { persist: true, desktop: { apiToken: token }, routes })
  try {
    await expect(page.locator('.document-tree-row').first()).toBeVisible({ timeout: 30_000 })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-table').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled table 2.ktable'])
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('ktable-editor')).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('table-title')).toHaveText('Untitled table 2.ktable')
    expect(reads).toContain('/workspace-files/Untitled table 2.ktable')
    await expect(page.getByTestId('kit-open-failed')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('a host write reaches the open table live, keeps the person’s unsaved edits, and is not the person’s undo', async ({ page, baseURL, browserName }) => {
  test.setTimeout(180_000)
  const { bytes, tableId } = await leadsFixture()
  await configureModel(page)

  // The runtime's bridge requests wait until the test lets them through: a host feature's record.
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
            arguments: { steps: [{ command: 'table.records.create', params: { tableId, values: { title: 'From the host' }, asOrigin: 'system:scenario' } }], save: false },
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

    // A host feature's record arrives through the bridge while the editor is open and unsaved.
    release()
    await expect.poll(() => posted.find((message) => message.id === 1), { timeout: 30_000 }).toBeTruthy()
    const answer = posted.find((message) => message.id === 1)!
    expect(answer.error).toBeUndefined()
    expect(answer.result).toMatchObject({ completed: [{ command: 'table.records.create', changed: true }], saved: false })
    await expect(records(kit)).toContainText('3 records')
    await expect(kit.getByTestId('table-unsaved')).toBeVisible()

    // The person's Undo takes back their own duplicate, never the host feature's record.
    await kit.getByTestId('table-undo').click()
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
      expect(saved.map((record) => record.values.title).sort()).toEqual(['Ada', 'From the host'])
      expect(saved.find((record) => record.values.title === 'Ada')?.values.tagline).toBe('Poetical science')
    }
  } finally {
    await host.dispose()
  }
})

test('Kition serves no design action, so the record menu offers none (host/action)', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { bytes } = await leadsFixture()
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Leads.ktable', bytes, {}, { routes: serveKitTables })
  try {
    await expect(records(kit)).toContainText('1 record', { timeout: 60_000 })
    await recordMenu(kit)
    await expect(kit.getByRole('button', { name: 'Create design from record' })).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

/**
 * Sends `host/generate` from inside the kit's frame over the kit's own channel to Kition, as a kit
 * editor does; the port is the one the kit received with `ui/initialize`'s handshake.
 */
async function generateFromKit(page: Page, purpose: string) {
  const frame = page.frames().find((candidate) => candidate.url().includes('/kits/table-ui/'))
  if (!frame) throw new Error('the Table kit frame is not open')
  return frame.evaluate(async (wanted) => {
    const port = (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort
    if (!port) throw new Error('the kit has no host channel')
    const id = `e2e-generate-${wanted}`
    return new Promise<{ result?: { text?: string; model?: string }; error?: { code: number; data?: { reason?: string } } }>((resolve) => {
      const answer = (event: MessageEvent) => {
        if (event.data?.id !== id) return
        port.removeEventListener('message', answer)
        resolve(event.data)
      }
      port.addEventListener('message', answer)
      port.postMessage({
        jsonrpc: '2.0',
        id,
        method: 'host/generate',
        params: { purpose: wanted, output: 'text', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Shorten: Ada wrote the first program for a machine that did not exist yet.' }] }] },
      })
    })
  }, purpose)
}

test('Kition serves host/generate for a rewrite of the person’s selection, and refuses a kit’s own purposes', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  const { bytes } = await leadsFixture()
  await configureModel(page)
  const generated: Array<Record<string, unknown>> = []
  const routes = async (page: Page) => {
    await serveKitTables(page)
    await page.route('**/api/v1/ai/generate', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      generated.push(body)
      // The runtime serves the defined purposes only (contracts/runtime/ai-generate.schema.json).
      if (body.purpose !== 'ai-field' && body.purpose !== 'rewrite') return fulfillJson(route, { code: 400, message: 'not a purpose', data: { reason: 'not-allowed' } }, 400)
      await fulfillJson(route, { code: 200, message: 'success', data: { text: 'Ada wrote the first program.', model: 'gpt-test' } })
    })
  }
  // Every frame keeps the host channel it is handed, so the test can speak for the kit.
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if ((event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 && event.ports[0]) (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort = event.ports[0]
    })
  })

  const { host, kit } = await openInKitFrame(page, baseURL!, 'Leads.ktable', bytes, {}, { routes })
  try {
    await expect(records(kit)).toContainText('1 record', { timeout: 60_000 })

    // `rewrite` is a defined purpose (Kit UI protocol 2.4 section 7j): Kition runs it on the person's model.
    const rewritten = await generateFromKit(page, 'rewrite')
    expect(rewritten.error).toBeUndefined()
    expect(rewritten.result).toMatchObject({ text: 'Ada wrote the first program.', model: 'gpt-test' })
    expect(generated).toHaveLength(1)
    expect(generated[0]).toMatchObject({ purpose: 'rewrite', output: 'text', runtimeModel: expect.objectContaining({ model_name: 'gpt-test' }) })
    expect(JSON.stringify(generated[0].messages)).toContain('Shorten:')

    // A kit's own purpose has no generic handling in Kition, and another kit's is never allowed (UI-G4).
    for (const purpose of ['table.summary', 'note.outline', 'chat']) {
      const refused = await generateFromKit(page, purpose)
      expect(refused.error).toMatchObject({ code: -32000, data: { reason: 'not-allowed' } })
    }
    expect(generated).toHaveLength(1)
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
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible({ timeout: 60_000 })
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId(`dashboard-tab-${dashboard}`)).toHaveAttribute('aria-current', 'page', { timeout: 60_000 })
    await expect(kit.getByTestId('dashboard-editor-pane')).toBeVisible()

    // Another table of the open file: the open editor shows it.
    await child('People').click()
    await expect(kit.getByTestId(`table-tab-${people}`)).toHaveAttribute('aria-current', 'page')
    await expect(kit.getByTestId('ktable-editor')).toBeVisible()
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toHaveCount(1)
  } finally {
    await host.dispose()
  }
})
