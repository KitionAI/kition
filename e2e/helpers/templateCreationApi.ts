import type { Page } from '@playwright/test'
import type { CreateDataDocumentPayload, DataDocument, DataRecord, ViewFieldLayout } from '../../src/types/dataDocument'
import { fulfillJson } from './mockApi'

export async function mockTemplateCreationApi(page: Page) {
  let document: DataDocument | null = null
  const records: DataRecord[] = []
  const layouts: ViewFieldLayout[] = []
  const uploads: string[] = []
  const stamp = { user_id: 1, created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' }
  await page.route(/\/api\/v1\/data-documents(?:[/?].*)?$/, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const reply = (data: unknown) => fulfillJson(route, { code: 200, data })
    if (path.endsWith('/attachments')) {
      uploads.push(path)
      return fulfillJson(route, { message: 'Template creation must not upload attachments' }, 400)
    }
    if (path === '/api/v1/data-documents') {
      if (method === 'GET') return reply({ items: document ? [document] : [], total: document ? 1 : 0 })
      const seed = request.postDataJSON() as CreateDataDocumentPayload
      document = {
        ...stamp, ...seed, id: 1, workspace_root: seed.workspace_root || '', path: seed.path || '', description: seed.description || '', icon: seed.icon || '', color: seed.color || '',
        tables: seed.tables!.map((table, tableIndex) => ({
          ...stamp, ...table, id: tableIndex + 1, document_id: 1, name: `table_${tableIndex}`,
          description: table.description || '', order: tableIndex,
          fields: table.fields!.map((field, index) => ({
            ...stamp, ...field, id: index + 1, document_id: 1, table_id: tableIndex + 1,
            name: `field_${index}`, is_primary: Boolean(field.primary),
            required: false, unique: false, readonly: false, order: index,
          })),
          views: table.views!.map((view, index) => ({
            ...stamp, ...view, id: index + 1, document_id: 1, table_id: tableIndex + 1,
            order: index, locked: false,
          })),
        })),
      }
      for (const table of document.tables!) for (const view of table.views!) {
        for (const field of table.fields!) layouts.push({
          view_id: view.id, field_id: field.id, visible: true, width: 200,
          position: field.order, frozen: field.is_primary,
        })
      }
      return reply(document)
    }
    const table = document?.tables?.[0]
    if (path.endsWith('/records')) {
      if (method === 'POST') {
        const record = { ...stamp, id: records.length + 1, document_id: 1, table_id: 1,
          row_key: `row_${records.length}`, order: records.length, values: request.postDataJSON().values }
        records.push(record)
        return reply(record)
      }
      return reply({ items: records, total: records.length, offset: 0, limit: 200 })
    }
    if (path.endsWith('/view-fields')) return reply({ items: layouts.filter((layout) => layout.view_id === Number(path.split('/').at(-2))) })
    if (method === 'PATCH') {
      const id = Number(path.split('/').at(-1))
      const target = path.includes('/view-fields/')
        ? layouts.find((layout) => layout.field_id === id && layout.view_id === Number(path.split('/').at(-3)))
        : path.includes('/fields/') ? table?.fields?.find((field) => field.id === id)
        : table?.views?.find((view) => view.id === id)
      if (target) Object.assign(target, request.postDataJSON())
      return reply(target)
    }
    return reply(document)
  })
  return { records, uploads }
}
