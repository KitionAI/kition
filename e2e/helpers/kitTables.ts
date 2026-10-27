import type { Page, Route } from '@playwright/test'

/**
 * Mocks the runtime's `/api/v1/kit-tables*` API (contracts/runtime/kit-tables.schema.json): the
 * workspace's `.ktable` files as Kition's own features (workflows, search,
 * design handoff) see them. Specs describe files and tables; the mock answers the list, fields,
 * records, and write endpoints from them and records every call it served.
 */
export type KitTableFieldFixture = {
  id: string
  name: string
  title?: string
  type?: string
  primary?: boolean
  options?: Record<string, unknown>
}

export type KitTableFixture = {
  id: string
  title: string
  name?: string
  fields?: KitTableFieldFixture[]
  /** Records with values keyed by field name. */
  records?: Array<{ id: string | number; values: Record<string, unknown> }>
  meta?: Record<string, unknown>
}

export type KitTableFileFixture = {
  path: string
  documentId?: string | null
  tables: KitTableFixture[]
}

export type KitTablesMockState = {
  files: KitTableFileFixture[]
  listCalls: number
  fieldsCalls: Array<{ path: string; tableId: string }>
  recordsCalls: Array<{ path: string; tableId: string }>
  recordWrites: Array<Record<string, unknown>>
  tableCreates: Array<Record<string, unknown>>
  tableUpdates: Array<Record<string, unknown>>
  fileCreates: Array<Record<string, unknown>>
  renames: Array<Record<string, unknown>>
  deletes: Array<Record<string, unknown>>
}

const DEFAULT_FIELDS: KitTableFieldFixture[] = [{ id: 'fld_name', name: 'name', title: 'Name', type: 'text', primary: true }]

function fieldsOf(table: KitTableFixture) {
  return (table.fields ?? DEFAULT_FIELDS).map((field, index) => ({
    id: field.id,
    name: field.name,
    title: field.title ?? field.name,
    type: field.type ?? 'text',
    primary: field.primary ?? index === 0,
    ...(field.options ? { options: field.options } : {}),
  }))
}

function tableOf(table: KitTableFixture) {
  return {
    id: table.id,
    name: table.name ?? table.title.toLowerCase().replace(/\W+/g, '_'),
    title: table.title,
    meta: table.meta ?? {},
    fields: fieldsOf(table),
  }
}

/** A fixture file's stamp: it changes with what the file holds, as a written file's does. */
function stampOf(file: KitTableFileFixture) {
  return String(JSON.stringify(file.tables).length)
}

function fileOf(file: KitTableFileFixture) {
  return { path: file.path, documentId: file.documentId ?? null, stamp: stampOf(file), tables: file.tables.map(tableOf), dashboards: [] }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: status === 200 ? 200 : status, data: body }) })
}

/** One table file, as `mockKitTables` takes it. */
export function kitTableFile(path: string, tables: KitTableFixture[], documentId: string | null = null): KitTableFileFixture {
  return { path, documentId, tables }
}

export async function mockKitTables(page: Page, files: KitTableFileFixture[]): Promise<KitTablesMockState> {
  const state: KitTablesMockState = {
    files,
    listCalls: 0,
    fieldsCalls: [],
    recordsCalls: [],
    recordWrites: [],
    tableCreates: [],
    tableUpdates: [],
    fileCreates: [],
    renames: [],
    deletes: [],
  }
  const findTable = (path: string, tableId: string) => state.files
    .find((file) => file.path === path)?.tables.find((table) => String(table.id) === String(tableId))

  await page.route('**/v1/kit-tables**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const endpoint = url.pathname.replace(/^.*\/v1\/kit-tables/, '')
    const method = request.method()
    const body = method === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {}

    if (method === 'GET' && endpoint === '') {
      state.listCalls += 1
      const only = url.searchParams.get('path')
      return json(route, { files: state.files.filter((file) => !only || file.path === only).map(fileOf), unreadable: [] })
    }
    if (method === 'GET' && endpoint === '/stamps') {
      return json(route, { files: state.files.map((file) => ({ path: file.path, stamp: stampOf(file) })) })
    }
    if (method === 'GET' && endpoint === '/fields') {
      const path = url.searchParams.get('path') || ''
      const tableId = url.searchParams.get('tableId') || ''
      state.fieldsCalls.push({ path, tableId })
      const table = findTable(path, tableId)
      if (!table) return json(route, { reason: 'not-found' }, 404)
      return json(route, {
        items: fieldsOf(table).map(({ primary, ...field }) => ({ ...field, is_primary: primary })),
        table: tableOf(table),
      })
    }
    if (method === 'GET' && endpoint === '/records') {
      const path = url.searchParams.get('path') || ''
      const tableId = url.searchParams.get('tableId') || ''
      state.recordsCalls.push({ path, tableId })
      const items = findTable(path, tableId)?.records ?? []
      return json(route, { items, total: items.length, offset: 0, limit: items.length })
    }
    if (method === 'POST' && endpoint === '/records') {
      state.recordWrites.push(body)
      const id = String(body.recordId || `rec_${state.recordWrites.length}`)
      return json(route, { id, values: body.values ?? {} })
    }
    if (method === 'POST' && endpoint === '/tables') {
      state.tableCreates.push(body)
      const file = state.files.find((item) => item.path === body.path)
      const seeds = (body.fields as Array<Record<string, unknown>> | undefined) ?? []
      const tableId = String(100 + state.tableCreates.length)
      const table: KitTableFixture = {
        id: tableId,
        title: String(body.title || 'Untitled table'),
        fields: seeds.map((seed, index) => ({
          id: `${tableId}_fld_${index + 1}`,
          name: String(seed.name || seed.title || `field_${index + 1}`).toLowerCase().replace(/\W+/g, '_'),
          title: String(seed.title || seed.name || `Field ${index + 1}`),
          type: String(seed.type || 'text'),
          primary: Boolean(seed.primary) || index === 0,
        })),
      }
      file?.tables.push(table)
      return json(route, tableOf(table))
    }
    if (method === 'POST' && endpoint === '/tables/update') {
      state.tableUpdates.push(body)
      const table = findTable(String(body.path || ''), String(body.tableId || ''))
      if (!table) return json(route, { reason: 'not-found' }, 404)
      if (typeof body.title === 'string') table.title = body.title
      if (body.meta && typeof body.meta === 'object') table.meta = body.meta as Record<string, unknown>
      return json(route, tableOf(table))
    }
    if (method === 'POST' && endpoint === '/files') {
      state.fileCreates.push(body)
      const file = kitTableFile(String(body.path || ''), [{ id: 'tbl_1', title: String(body.title || 'Table 1') }])
      state.files.push(file)
      return json(route, { path: file.path, tables: file.tables.map(tableOf) })
    }
    if (method === 'POST' && endpoint === '/attachments') {
      return json(route, { url: 'kition-blob:0000', name: body.name, mimeType: body.mime, size: 0 })
    }
    if (method === 'POST' && endpoint === '/renamed') {
      state.renames.push(body)
      return json(route, { updated: 0 })
    }
    if (method === 'POST' && endpoint === '/deleted') {
      state.deletes.push(body)
      const gone = String(body.path || '')
      state.files = state.files.filter((file) => file.path !== gone && !file.path.startsWith(`${gone}/`))
      return json(route, { removed: 0 })
    }
    return json(route, { reason: 'not-found' }, 404)
  })
  return state
}
