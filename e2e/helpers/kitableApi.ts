import type { Page } from '@playwright/test'

import { fulfillJson } from './mockApi'
import type { DataDocumentsTransactOp, DataDocumentsTransactTableChange } from '../../src/api/generated/data-documents-transact'
import type { TableChangedParams } from '../../src/api/generated/table-changed'
import type { DataDocumentsReplicaReplicaChanged } from '../../src/api/generated/data-documents-replica'

/**
 * Mocks for the Kitable (Table kit) editor: the desktop shell bridge
 * (`window.kitionDesktop`) and the `/v1/data-documents` HTTP API, shared by
 * `e2e/kitable.spec.ts` and any other spec that opens the Kitable editor.
 *
 * Also mocks the kit bridge SSE stream (`GET /v1/kits/bridge`) lazily, the
 * first time a spec calls `emitTableChanged`, so a spec that never needs a
 * live `table/changed` event does not pay for it. This duplicates (does not
 * share) the queue/session plumbing in `e2e/helpers/documentBridge.ts`: that
 * one layers a request/response protocol (`document/read`, `document/apply`,
 * answered by id) over the same stream, while this one only ever sends
 * fire-and-forget notifications, so there is no common abstraction simple
 * enough to be worth factoring out yet.
 */

export const VAULT_PATH = '/tmp/kition-kitable-e2e-vault'
export const DOC_PATH = 'table-test.kitable'
export const DOC_MARKER = JSON.stringify({ data_document_id: 1 })

export const FIXTURE_DOCUMENT = {
  id: 1,
  user_id: 1,
  workspace_root: VAULT_PATH,
  path: DOC_PATH,
  title: 'Table Test',
  description: '',
  icon: '',
  color: '',
  meta: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  tables: [
    {
      id: 11,
      user_id: 1,
      document_id: 1,
      name: 'tasks',
      title: 'Tasks',
      description: '',
      order: 0,
      primary_field_id: 101,
      meta: null,
      fields: [
        {
          id: 101,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          name: 'title',
          title: 'Title',
          type: 'text',
          required: false,
          unique: false,
          readonly: false,
          is_primary: true,
          order: 0,
          options: null,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 102,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          name: 'score',
          title: 'Score',
          type: 'rating',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 1,
          options: { max: 5, icon: 'star' },
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
        {
          id: 103,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          name: 'received_at',
          title: 'Received At',
          type: 'datetime',
          required: false,
          unique: false,
          readonly: false,
          is_primary: false,
          order: 2,
          options: null,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      views: [
        {
          id: 201,
          user_id: 1,
          document_id: 1,
          table_id: 11,
          title: 'All tasks',
          type: 'grid',
          order: 0,
          locked: false,
          config: {},
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ],
}

export const FIXTURE_RECORDS = {
  items: [
    {
      id: 1001,
      user_id: 1,
      document_id: 1,
      table_id: 11,
      row_key: 'r_one',
      order: 0,
      values: { title: 'Phase 2 wrap', score: 4, received_at: '2026-07-23T04:14:47Z' },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 1002,
      user_id: 1,
      document_id: 1,
      table_id: 11,
      row_key: 'r_two',
      order: 1,
      values: { title: 'Phase 3 deferred', score: 0, received_at: '2026-07-24T05:15:48Z' },
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ],
  total: 2,
  offset: 0,
  limit: 200,
}

export async function mockKitableDesktopBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, marker }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content: marker, updated_at: new Date().toISOString() })

      const vault = {
        path: vaultPath,
        name: 'Kitable E2E Vault',
        added_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      }

      function makeListResponse() {
        return {
          root_path: vaultPath,
          items: Array.from(docs.keys()).map((path) => ({
            type: 'file' as const,
            path,
            name: path.split('/').pop() || path,
            format: 'data' as const,
            size: (docs.get(path)?.content || '').length,
            updated_at: docs.get(path)?.updated_at || '',
          })),
        }
      }

      function makeRegistry() {
        return { vaults: [vault], active_vault_path: vaultPath }
      }

      stateWindow.kitionDesktop = {
        shell: 'tauri',
        DesktopInfo: async () => ({
          is_desktop: true,
          platform: 'darwin',
          backend_base_url: 'http://127.0.0.1:18101/api',
          data_dir: '/tmp/kition/data',
          cache_dir: '/tmp/kition/cache',
          logs_dir: '/tmp/kition/logs',
          uploads_dir: '/tmp/kition/uploads',
          exports_dir: '/tmp/kition/exports',
          workspace_dir: vaultPath,
          supports_secure_storage: true,
        }),
        StoreSecureValue: async (key: string, value: string) => {
          secureStore.set(key, value)
        },
        ReadSecureValue: async (key: string) => secureStore.get(key) || '',
        DeleteSecureValue: async (key: string) => {
          secureStore.delete(key)
        },
        OpenExternalURL: async () => {},

        ListVaults: async () => makeRegistry(),
        AddVault: async () => ({ vault, registry: makeRegistry() }),
        RemoveVault: async () => makeRegistry(),
        RenameVault: async () => ({ vault, registry: makeRegistry() }),
        SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),

        ListWorkspaceDocuments: async () => makeListResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) {
            throw new Error(`document not found: ${req.path}`)
          }
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: record.content,
            format: 'data',
            updated_at: record.updated_at,
            size: record.content.length,
          }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: req.content,
            format: 'data',
            updated_at,
            size: req.content.length,
          }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, marker: DOC_MARKER },
  )

  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

export type MockTableOp = DataDocumentsTransactOp
export type MockTableChange = DataDocumentsTransactTableChange
export type MockTableDocument = typeof FIXTURE_DOCUMENT
export type MockRecord = (typeof FIXTURE_RECORDS.items)[number]

/** Mutable counters `applyMockTableOps` draws new ids and row keys from, across calls. */
export type MockTableCounters = { nextRecordId: number; nextRowKey: number }

export function freshMockTableCounters(): MockTableCounters {
  return { nextRecordId: 2000, nextRowKey: 0 }
}

/** An empty TableChange, for an undo/redo that had nothing to do. */
export function emptyMockTableChange(documentId: string, origin: string): MockTableChange {
  return {
    documentId,
    origin,
    tables: [],
    schema: [],
    views: [],
    recordsUpserted: [],
    recordsDeleted: [],
    recordsReordered: [],
    dashboards: false,
  }
}

/** Keeps each table's records' `order` sequential and zero-based after a mutation. */
function renumberRecordOrders(records: MockRecord[]) {
  const next = new Map<number, number>()
  for (const record of records) {
    const order = next.get(record.table_id) ?? 0
    record.order = order
    next.set(record.table_id, order + 1)
  }
}

/**
 * Applies a transaction's ops to the mock's in-memory `records` (and, for
 * `fields.move`, `document`'s field order), the same way the real runtime
 * will apply them to the KDM. Exported so a plain unit test can check its
 * fidelity (honoring `records.create`'s `at`, actually reordering for
 * `records.move`/`fields.move`, matching `table_id`) without touching a page,
 * a route, or the app.
 */
export function applyMockTableOps(
  document: MockTableDocument,
  records: MockRecord[],
  ops: MockTableOp[],
  documentId: string,
  origin: string,
  counters: MockTableCounters,
): { ok: boolean; change: MockTableChange; created: string[]; error?: string } {
  // A flat (not discriminated-union) result: the repo's tsconfig runs with
  // strict: false, under which this version of TypeScript does not narrow a
  // `{ok:true,...}|{ok:false,...}` union on its `ok: false` side (only on
  // `ok: true`), so callers checking `!result.ok` could not reach `.error`.
  if (ops.length === 0) {
    return { ok: false, change: emptyMockTableChange(documentId, origin), created: [], error: 'ops must not be empty' }
  }

  const created: string[] = []
  const upserted: Array<[number, string]> = []
  const deleted: Array<[number, string]> = []
  const reordered = new Set<number>()
  const schemaChanged = new Set<number>()

  for (const op of ops) {
    if (op.op === 'cells.set') {
      for (const entry of op.records) {
        const target = records.find((record) => record.row_key === entry.rowKey && record.table_id === op.tableId)
        if (!target) continue
        Object.assign(target.values, entry.values)
        upserted.push([op.tableId, entry.rowKey])
      }
    } else if (op.op === 'records.create') {
      const newRows: MockRecord[] = op.records.map((values) => {
        const rowKey = `e2e_${counters.nextRowKey++}`
        created.push(rowKey)
        upserted.push([op.tableId, rowKey])
        return {
          id: counters.nextRecordId++,
          user_id: 1,
          document_id: Number(documentId),
          table_id: op.tableId,
          row_key: rowKey,
          order: 0,
          values: { ...values },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as MockRecord
      })
      const at = op.at
      let insertIndex = records.length
      if (at && 'before' in at) {
        const anchor = records.findIndex((record) => record.row_key === at.before)
        if (anchor >= 0) insertIndex = anchor
      } else if (at && 'after' in at) {
        const anchor = records.findIndex((record) => record.row_key === at.after)
        if (anchor >= 0) insertIndex = anchor + 1
      }
      records.splice(insertIndex, 0, ...newRows)
    } else if (op.op === 'records.delete') {
      for (const rowKey of op.rowKeys) {
        const index = records.findIndex((record) => record.row_key === rowKey && record.table_id === op.tableId)
        if (index < 0) continue
        records.splice(index, 1)
        deleted.push([op.tableId, rowKey])
      }
    } else if (op.op === 'records.move') {
      const movingKeys = op.rowKeys.filter((rowKey) =>
        records.some((record) => record.row_key === rowKey && record.table_id === op.tableId))
      if (movingKeys.length > 0) {
        const movingSet = new Set(movingKeys)
        const movingRecords = movingKeys
          .map((rowKey) => records.find((record) => record.row_key === rowKey))
          .filter((record): record is MockRecord => Boolean(record))
        const remaining = records.filter((record) => !movingSet.has(record.row_key))
        let insertIndex = remaining.length
        if (op.before) {
          const anchor = remaining.findIndex((record) => record.row_key === op.before)
          if (anchor >= 0) insertIndex = anchor
        }
        remaining.splice(insertIndex, 0, ...movingRecords)
        records.splice(0, records.length, ...remaining)
        reordered.add(op.tableId)
      }
    } else if (op.op === 'fields.move') {
      const table = document.tables.find((item) => item.id === op.tableId)
      if (table) {
        const movingIds = new Set(op.fieldIds)
        const movingFields = table.fields.filter((field) => movingIds.has(field.id))
        const remainingFields = table.fields.filter((field) => !movingIds.has(field.id))
        const insertIndex = Math.max(0, Math.min(op.toIndex, remainingFields.length))
        remainingFields.splice(insertIndex, 0, ...movingFields)
        remainingFields.forEach((field, index) => { field.order = index })
        table.fields.splice(0, table.fields.length, ...remainingFields)
        schemaChanged.add(op.tableId)
      }
    }
  }

  renumberRecordOrders(records)

  return {
    ok: true,
    created,
    change: {
      documentId,
      origin,
      tables: [],
      schema: [...schemaChanged],
      views: [],
      recordsUpserted: upserted,
      recordsDeleted: deleted,
      recordsReordered: [...reordered],
      dashboards: false,
    },
  }
}

function originFromRequestHeaders(headers: Record<string, string>) {
  const session = headers['kition-session']
  return session ? `person:session:${session}` : 'unknown'
}

/**
 * The mock's stand-in for the document's KDM replica (`/data-documents/replica/*`): opaque
 * base64 a spec sets and reads; it does not merge anything. `version` and `changes` are what
 * `replica/version` and `replica/export` answer; `imported` collects every `replica/import`, and
 * `created` every `replica/create`.
 */
export type MockTableReplica = {
  docId: string
  version: string
  changes: string
  imported: string[]
  /** Every `replica/create`; answered like `replica/version`. */
  created: Array<{ path: string; changes: string }>
}

export async function mockKitableDataDocumentApi(page: Page) {
  const document: MockTableDocument = structuredClone(FIXTURE_DOCUMENT)
  const records: MockRecord[] = FIXTURE_RECORDS.items.map((item) => ({ ...item, values: { ...item.values } }))
  const counters = freshMockTableCounters()
  const replica: MockTableReplica = { docId: '00000000-0000-4000-8000-000000000001', version: '', changes: '', imported: [], created: [] }

  function recordsResponse() {
    return { items: records, total: records.length, offset: 0, limit: 200 }
  }

  await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return fulfillJson(route, {
      code: 200,
      data: { items: [document], total: 1, offset: 0, limit: 200 },
    })
  })

  await page.route('**/api/v1/data-documents/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/replica/{version,export,import} → the opaque mock replica
    const replicaMatch = path.match(/^\/api\/v1\/data-documents\/replica\/(version|export|import|create)$/)
    if (method === 'POST' && replicaMatch) {
      const body = (request.postDataJSON() ?? {}) as { path?: string; changes?: string }
      const identity = { documentId: String(document.id), documentPath: body.path ?? document.path, docId: replica.docId, version: replica.version }
      if (replicaMatch[1] === 'version') return fulfillJson(route, { code: 200, data: identity })
      if (replicaMatch[1] === 'create') {
        replica.created.push({ path: body.path ?? '', changes: body.changes ?? '' })
        return fulfillJson(route, { code: 200, data: identity })
      }
      if (replicaMatch[1] === 'export') return fulfillJson(route, { code: 200, data: { ...identity, changes: replica.changes } })
      replica.imported.push(body.changes ?? '')
      return fulfillJson(route, { code: 200, data: { ...identity, change: emptyMockTableChange(String(document.id), 'import:sync') } })
    }

    // POST /data-documents/open → resolve a path to the doc
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: document })
    }

    // GET /data-documents/1 → full document with embedded tables + fields + views
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: document })
    }

    // GET /data-documents/1/tables/11/records?limit=
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/tables\/\d+\/records$/.test(path)) {
      return fulfillJson(route, { code: 200, data: recordsResponse() })
    }

    if (method === 'GET' && /\/views\/\d+\/view-fields$/.test(path)) {
      return fulfillJson(route, {
        code: 200,
        data: {
          items: [
            { view_id: 201, field_id: 101, visible: true, width: 200, position: 0, frozen: true },
            { view_id: 201, field_id: 102, visible: true, width: 200, position: 1, frozen: false },
            { view_id: 201, field_id: 103, visible: true, width: 200, position: 2, frozen: false },
          ],
        },
      })
    }

    if (method === 'PATCH' && /\/views\/\d+\/view-fields\/\d+$/.test(path)) {
      const fieldId = Number(path.split('/').pop())
      return fulfillJson(route, {
        code: 200,
        data: {
          view_id: 201,
          field_id: fieldId,
          visible: true,
          width: Number(request.postDataJSON()?.width || 200),
          position: 0,
          frozen: fieldId === 101,
        },
      })
    }

    // POST /data-documents/1/transact → applies every op to the in-memory records.
    const transactMatch = path.match(/^\/api\/v1\/data-documents\/(\d+)\/transact$/)
    if (method === 'POST' && transactMatch) {
      const documentId = transactMatch[1]
      const origin = originFromRequestHeaders(request.headers())
      const body = (request.postDataJSON() ?? {}) as { ops?: MockTableOp[] }
      const result = applyMockTableOps(document, records, body.ops ?? [], documentId, origin, counters)
      if (!result.ok) {
        return fulfillJson(route, { code: 400, message: result.error }, 400)
      }
      return fulfillJson(route, { code: 200, data: { change: result.change, created: result.created } })
    }

    // POST /data-documents/1/undo and /redo → minimal mock: never anything to undo or redo.
    const undoRedoMatch = path.match(/^\/api\/v1\/data-documents\/(\d+)\/(undo|redo)$/)
    if (method === 'POST' && undoRedoMatch) {
      const [, documentId] = undoRedoMatch
      const origin = originFromRequestHeaders(request.headers())
      return fulfillJson(route, { code: 200, data: { done: false, change: emptyMockTableChange(documentId, origin) } })
    }

    // GET /data-documents/1/history-state → minimal mock: nothing to undo or redo yet.
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/history-state$/.test(path)) {
      return fulfillJson(route, { code: 200, data: { canUndo: false, canRedo: false } })
    }

    // Fallback for anything else under data-documents (PATCH view, dashboards, etc.) — empty success.
    return fulfillJson(route, { code: 200, data: {} })
  })

  return { document, records, replica }
}

type BridgeMessage = { jsonrpc: '2.0'; id?: number; method?: string; params?: Record<string, unknown> }

const kitBridgeQueues = new WeakMap<Page, BridgeMessage[]>()

async function ensureKitBridgeStream(page: Page) {
  if (kitBridgeQueues.has(page)) return
  const queue: BridgeMessage[] = []
  kitBridgeQueues.set(page, queue)
  let session = 0

  // Mirrors e2e/helpers/documentBridge.ts: the GET answers with bridge.ready plus
  // whatever queued since the last poll, then ends; the browser reconnects at
  // once (`retry`), so a queued message reaches the page within moments. See
  // the file-level comment for why this is not shared code with that helper.
  await page.route('**/v1/kits/bridge', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    session += 1
    const messages: BridgeMessage[] = [{ jsonrpc: '2.0', method: 'bridge.ready', params: { session } }, ...queue.splice(0)]
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: `retry: 50\n\n${messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('')}`,
    })
  })
  await page.route('**/v1/kits/bridge?**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, message: 'success', data: {} }) })
  })
}

/** Injects a `table/replica-changed` notification into the page's kit bridge stream. */
export async function emitTableReplicaChanged(page: Page, params: DataDocumentsReplicaReplicaChanged) {
  await ensureKitBridgeStream(page)
  kitBridgeQueues.get(page)!.push({ jsonrpc: '2.0', method: 'table/replica-changed', params })
}

/** Injects a `table/changed` notification into the page's kit bridge stream. */
export async function emitTableChanged(page: Page, params: TableChangedParams) {
  await ensureKitBridgeStream(page)
  kitBridgeQueues.get(page)!.push({ jsonrpc: '2.0', method: 'table/changed', params })
}
