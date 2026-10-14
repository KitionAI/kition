import type { Page } from '@playwright/test'

import { fulfillJson } from './mockApi'

/**
 * Mocks for the Kitable (Table kit) editor: the desktop shell bridge
 * (`window.kitionDesktop`) and the `/v1/data-documents` HTTP API, shared by
 * `e2e/kitable.spec.ts` and any other spec that opens the Kitable editor.
 *
 * Also mocks the kit bridge SSE stream (`GET /v1/kits/bridge`) lazily, the
 * first time a spec calls `emitTableChanged`, so a spec that never needs a
 * live `table/changed` event does not pay for it.
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

type MockOp = {
  op: string
  tableId: number
  records?: Array<{ rowKey: string; values?: Record<string, unknown> } | Record<string, unknown>>
  rowKeys?: string[]
  before?: string | null
  fieldIds?: number[]
}

type MockRecord = (typeof FIXTURE_RECORDS.items)[number]

/** An empty TableChange, for an undo/redo that had nothing to do. */
function emptyChange(documentId: string, origin: string) {
  return {
    documentId,
    origin,
    tables: [] as number[],
    schema: [] as number[],
    views: [] as number[],
    recordsUpserted: [] as Array<[number, string]>,
    recordsDeleted: [] as Array<[number, string]>,
    recordsReordered: [] as number[],
    dashboards: false,
  }
}

function originFromRequestHeaders(headers: Record<string, string>) {
  const session = headers['kition-session']
  return session ? `person:session:${session}` : 'unknown'
}

export async function mockKitableDataDocumentApi(page: Page) {
  const records: MockRecord[] = FIXTURE_RECORDS.items.map((item) => ({ ...item, values: { ...item.values } }))
  let nextRecordId = 2000
  let nextRowKey = 0

  function recordsResponse() {
    return { items: records, total: records.length, offset: 0, limit: 200 }
  }

  await page.route(/\/api\/v1\/data-documents(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return fulfillJson(route, {
      code: 200,
      data: { items: [FIXTURE_DOCUMENT], total: 1, offset: 0, limit: 200 },
    })
  })

  await page.route('**/api/v1/data-documents/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // POST /data-documents/open → resolve a path to the doc
    if (method === 'POST' && path === '/api/v1/data-documents/open') {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
    }

    // GET /data-documents/1 → full document with embedded tables + fields + views
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+$/.test(path)) {
      return fulfillJson(route, { code: 200, data: FIXTURE_DOCUMENT })
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
      const body = (request.postDataJSON() ?? {}) as { ops?: MockOp[] }
      const created: string[] = []
      const upserted: Array<[number, string]> = []
      const deleted: Array<[number, string]> = []
      const reordered = new Set<number>()
      const schemaChanged = new Set<number>()

      for (const op of body.ops ?? []) {
        if (op.op === 'cells.set') {
          for (const entry of op.records ?? []) {
            const { rowKey, values } = entry as { rowKey: string; values?: Record<string, unknown> }
            const target = records.find((record) => record.row_key === rowKey)
            if (!target) continue
            Object.assign(target.values, values)
            upserted.push([op.tableId, rowKey])
          }
        } else if (op.op === 'records.create') {
          for (const values of (op.records ?? []) as Array<Record<string, unknown>>) {
            const rowKey = `e2e_${nextRowKey++}`
            records.push({
              id: nextRecordId++,
              user_id: 1,
              document_id: Number(documentId),
              table_id: op.tableId,
              row_key: rowKey,
              order: records.length,
              values,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            } as MockRecord)
            created.push(rowKey)
            upserted.push([op.tableId, rowKey])
          }
        } else if (op.op === 'records.delete') {
          for (const rowKey of op.rowKeys ?? []) {
            const index = records.findIndex((record) => record.row_key === rowKey)
            if (index < 0) continue
            records.splice(index, 1)
            deleted.push([op.tableId, rowKey])
          }
        } else if (op.op === 'records.move') {
          reordered.add(op.tableId)
        } else if (op.op === 'fields.move') {
          schemaChanged.add(op.tableId)
        }
      }

      const change = {
        documentId,
        origin,
        tables: [] as number[],
        schema: [...schemaChanged],
        views: [] as number[],
        recordsUpserted: upserted,
        recordsDeleted: deleted,
        recordsReordered: [...reordered],
        dashboards: false,
      }
      return fulfillJson(route, { code: 200, data: { change, created } })
    }

    // POST /data-documents/1/undo and /redo → minimal mock: never anything to undo or redo.
    const undoRedoMatch = path.match(/^\/api\/v1\/data-documents\/(\d+)\/(undo|redo)$/)
    if (method === 'POST' && undoRedoMatch) {
      const [, documentId] = undoRedoMatch
      const origin = originFromRequestHeaders(request.headers())
      return fulfillJson(route, { code: 200, data: { done: false, change: emptyChange(documentId, origin) } })
    }

    // GET /data-documents/1/history-state → minimal mock: nothing to undo or redo yet.
    if (method === 'GET' && /^\/api\/v1\/data-documents\/\d+\/history-state$/.test(path)) {
      return fulfillJson(route, { code: 200, data: { canUndo: false, canRedo: false } })
    }

    // Fallback for anything else under data-documents (PATCH view, dashboards, etc.) — empty success.
    return fulfillJson(route, { code: 200, data: {} })
  })

  return { records }
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
  // once (`retry`), so a queued message reaches the page within moments.
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

/** Injects a `table/changed` notification into the page's kit bridge stream. */
export async function emitTableChanged(page: Page, params: Record<string, unknown>) {
  await ensureKitBridgeStream(page)
  kitBridgeQueues.get(page)!.push({ jsonrpc: '2.0', method: 'table/changed', params })
}
