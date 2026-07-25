import request from './request'
import type {
  BulkCopyRecordsPayload,
  BulkCopyRecordsResult,
  BulkDeleteRecordsPayload,
  BulkDeleteRecordsResult,
  CreateDataDocumentPayload,
  CreateDataFieldPayload,
  CreateDataTablePayload,
  CreateDataViewPayload,
  DataAttachment,
  DataDocument,
  DataField,
  DataListResponse,
  DataRecord,
  DataRecordValue,
  DataTable,
  DataView,
  GroupItem,
  InferDataDocumentSchemaResponse,
  LinkRef,
  RecordHistoryResponse,
  SortItem,
  ViewFieldLayout,
  ViewFieldPatchPayload,
  ViewFieldsResponse,
  ViewGroupsResponse,
  ViewSortsResponse,
} from '@/types/dataDocument'
import type { RuntimeWritingModel } from '@/types'
import type { AnyAIConfig } from '@/types/aiConfig'
import { statWorkspaceDocument } from '@/services/desktop'

function unwrapResponseData<T>(response: T | { data?: T }) {
  return (response as { data?: T })?.data ?? (response as T)
}

                                             
                                                                   
                                                                         
function normalizeField(field: DataField | undefined | null): DataField {
  if (!field) return field as DataField
  const options = (field.options ?? {}) as Record<string, unknown>
  if (!('ai_config' in options)) return field
  const { ai_config, ...rest } = options
  return {
    ...field,
    options: rest,
    ai_config: (ai_config as AnyAIConfig | null | undefined) ?? null,
  }
}

function normalizeTable<T extends Pick<DataTable, 'fields'>>(table: T | undefined | null): T {
  if (!table || !Array.isArray(table.fields)) return table as T
  return { ...table, fields: table.fields.map(normalizeField) }
}

function normalizeDocument<T extends Pick<DataDocument, 'tables'>>(doc: T | undefined | null): T {
  if (!doc || !Array.isArray(doc.tables)) return doc as T
  return { ...doc, tables: doc.tables.map(normalizeTable) }
}

function normalizeDocumentList(payload: DataListResponse<DataDocument>) {
  if (!payload || !Array.isArray(payload.items)) return payload
  return { ...payload, items: payload.items.map(normalizeDocument) }
}

export function listDataDocuments(params?: { workspace_root?: string; query?: string }) {
  return request
    .get<DataListResponse<DataDocument> | { data?: DataListResponse<DataDocument> }>('/v1/data-documents', { params })
    .then(unwrapResponseData<DataListResponse<DataDocument>>)
    .then(normalizeDocumentList)
}

export function getDataDocument(documentId: number) {
  return request
    .get<DataDocument | { data?: DataDocument }>(`/v1/data-documents/${documentId}`)
    .then(unwrapResponseData<DataDocument>)
    .then(normalizeDocument)
}

export function createDataDocument(payload: CreateDataDocumentPayload) {
  return request
    .post<DataDocument | { data?: DataDocument }>('/v1/data-documents', payload)
    .then(unwrapResponseData<DataDocument>)
    .then(normalizeDocument)
}

export async function openDataDocumentByPath(payload: { path: string; workspace_root?: string }) {
  if (payload.path.toLowerCase().endsWith('.kitable')) {
    const stat = await statWorkspaceDocument(payload.path).catch(() => null)
    if (stat?.size === 0) {
      throw new Error('This Kitable file is empty or incomplete.')
    }
  }
  return request
    .post<DataDocument | { data?: DataDocument }>('/v1/data-documents/open', payload)
    .then(unwrapResponseData<DataDocument>)
    .then(normalizeDocument)
}

export function updateDataDocument(documentId: number, payload: Partial<CreateDataDocumentPayload>) {
  return request
    .patch<DataDocument | { data?: DataDocument }>(`/v1/data-documents/${documentId}`, payload)
    .then(unwrapResponseData<DataDocument>)
    .then(normalizeDocument)
}

export function deleteDataDocument(documentId: number) {
  return request.delete(`/v1/data-documents/${documentId}`)
}

export function deleteDataDocumentByPath(payload: { path: string; workspace_root?: string }) {
  return request
    .post<{ deleted: boolean; workflows_removed: number } | { data?: { deleted: boolean; workflows_removed: number } }>(
      '/v1/data-documents/delete-by-path',
      payload,
    )
    .then(unwrapResponseData<{ deleted: boolean; workflows_removed: number }>)
}

export function renameDataDocumentByPath(payload: { path: string; target_path: string; workspace_root?: string }) {
  return request
    .post<{ renamed: boolean; count: number } | { data?: { renamed: boolean; count: number } }>(
      '/v1/data-documents/rename-by-path',
      payload,
    )
    .then(unwrapResponseData<{ renamed: boolean; count: number }>)
}

export function createDataTable(documentId: number, payload: CreateDataTablePayload) {
  return request
    .post<DataTable | { data?: DataTable }>(`/v1/data-documents/${documentId}/tables`, payload)
    .then(unwrapResponseData<DataTable>)
    .then(normalizeTable)
}

export function updateDataTable(documentId: number, tableId: number, payload: Partial<CreateDataTablePayload>) {
  return request
    .patch<DataTable | { data?: DataTable }>(`/v1/data-documents/${documentId}/tables/${tableId}`, payload)
    .then(unwrapResponseData<DataTable>)
    .then(normalizeTable)
}

export function deleteDataTable(documentId: number, tableId: number) {
  return request.delete(`/v1/data-documents/${documentId}/tables/${tableId}`)
}

export function createDataField(documentId: number, tableId: number, payload: CreateDataFieldPayload) {
  return request
    .post<DataField | { data?: DataField }>(`/v1/data-documents/${documentId}/tables/${tableId}/fields`, payload)
    .then(unwrapResponseData<DataField>)
    .then(normalizeField)
}

export function updateDataField(documentId: number, tableId: number, fieldId: number, payload: Partial<CreateDataFieldPayload>) {
  return request
    .patch<DataField | { data?: DataField }>(`/v1/data-documents/${documentId}/tables/${tableId}/fields/${fieldId}`, payload)
    .then(unwrapResponseData<DataField>)
    .then(normalizeField)
}

export function deleteDataField(documentId: number, tableId: number, fieldId: number) {
  return request.delete(`/v1/data-documents/${documentId}/tables/${tableId}/fields/${fieldId}`)
}

export function duplicateDataField(documentId: number, tableId: number, fieldId: number) {
  return request
    .post<DataField | { data?: DataField }>(`/v1/data-documents/${documentId}/tables/${tableId}/fields/${fieldId}/duplicate`)
    .then(unwrapResponseData<DataField>)
    .then(normalizeField)
}

export function createDataView(documentId: number, tableId: number, payload: CreateDataViewPayload) {
  return request
    .post<DataView | { data?: DataView }>(`/v1/data-documents/${documentId}/tables/${tableId}/views`, payload)
    .then(unwrapResponseData<DataView>)
}

export function updateDataView(documentId: number, tableId: number, viewId: number, payload: Partial<CreateDataViewPayload>) {
  return request
    .patch<DataView | { data?: DataView }>(`/v1/data-documents/${documentId}/tables/${tableId}/views/${viewId}`, payload)
    .then(unwrapResponseData<DataView>)
}

export function deleteDataView(documentId: number, tableId: number, viewId: number) {
  return request.delete(`/v1/data-documents/${documentId}/tables/${tableId}/views/${viewId}`)
}

export function listDataRecords(documentId: number, tableId: number, params?: { limit?: number; offset?: number }) {
  return request
    .get<DataListResponse<DataRecord> | { data?: DataListResponse<DataRecord> }>(`/v1/data-documents/${documentId}/tables/${tableId}/records`, { params })
    .then(unwrapResponseData<DataListResponse<DataRecord>>)
}

export function createDataRecord(documentId: number, tableId: number, values: Record<string, DataRecordValue>) {
  return request
    .post<DataRecord | { data?: DataRecord }>(`/v1/data-documents/${documentId}/tables/${tableId}/records`, { values })
    .then(unwrapResponseData<DataRecord>)
}

export function updateDataRecord(documentId: number, tableId: number, recordId: number, values: Record<string, DataRecordValue>) {
  return request
    .patch<DataRecord | { data?: DataRecord }>(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}`, { values })
    .then(unwrapResponseData<DataRecord>)
}

export function updateDataRecordOrder(documentId: number, tableId: number, recordId: number, order: number) {
  return request
    .patch<DataRecord | { data?: DataRecord }>(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}`, { order })
    .then(unwrapResponseData<DataRecord>)
}

export function runDataAIFieldCell(
  documentId: number,
  tableId: number,
  recordId: number,
  fieldId: number,
  payload: {
    action: string
    config: AnyAIConfig
    force?: boolean
    runtime_model?: RuntimeWritingModel
  },
  options?: { signal?: AbortSignal },
) {
  return request
    .post<{ record: DataRecord; field: DataField; state?: Record<string, unknown> } | { data?: { record: DataRecord; field: DataField; state?: Record<string, unknown> } }>(
      `/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}/fields/${fieldId}/ai/run`,
      payload,
      { signal: options?.signal },
    )
    .then(unwrapResponseData<{ record: DataRecord; field: DataField; state?: Record<string, unknown> }>)
    .then((result) => ({ ...result, field: normalizeField(result.field) }))
}

export type RunDataAIFieldBatchResponse = {
  items: Array<{ record: DataRecord; state?: Record<string, unknown> }>
  field: DataField
  accepted: number
  completed: number
  failed: number
  errors?: Array<{ record_id: number; message: string }>
  limit: number
}

export function runDataAIFieldBatch(
  documentId: number,
  tableId: number,
  fieldId: number,
  payload: {
    action: string
    config: AnyAIConfig
    record_ids: number[]
    scope?: string
    force?: boolean
    limit?: number
    runtime_model?: RuntimeWritingModel
  },
  options?: { signal?: AbortSignal },
) {
  return request
    .post<RunDataAIFieldBatchResponse | { data?: RunDataAIFieldBatchResponse }>(
      `/v1/data-documents/${documentId}/tables/${tableId}/fields/${fieldId}/ai/run`,
      payload,
      { signal: options?.signal },
    )
    .then(unwrapResponseData<RunDataAIFieldBatchResponse>)
    .then((result) => ({ ...result, field: normalizeField(result.field) }))
}

export function deleteDataRecord(documentId: number, tableId: number, recordId: number) {
  return request.delete(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}`)
}

type LinkItemsResponse = { items?: LinkRef[] } | LinkRef[]

function unwrapLinkItems(response: LinkItemsResponse | { data?: LinkItemsResponse }): LinkRef[] {
  const payload = (response as { data?: LinkItemsResponse })?.data ?? (response as LinkItemsResponse)
  if (Array.isArray(payload)) return payload
  return payload?.items ?? []
}

export function listRecordLinks(documentId: number, tableId: number, recordId: number, fieldId: number) {
  return request
    .get<LinkItemsResponse | { data?: LinkItemsResponse }>(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}/links`, { params: { field_id: fieldId } })
    .then(unwrapLinkItems)
}

export function replaceRecordLinks(documentId: number, tableId: number, recordId: number, fieldId: number, targetRowKeys: string[]) {
  return request
    .post<LinkItemsResponse | { data?: LinkItemsResponse }>(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}/links`, {
      field_id: fieldId,
      target_row_keys: targetRowKeys,
    })
    .then(unwrapLinkItems)
}

export function deleteRecordLinks(documentId: number, tableId: number, recordId: number, fieldId: number, targetRowKeys: string[]) {
  return request.delete(`/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}/links`, {
    data: { field_id: fieldId, target_row_keys: targetRowKeys },
  })
}

export function listLinkCandidates(documentId: number, tableId: number, fieldId: number, query: string, limit = 25) {
  return request
    .get<LinkItemsResponse | { data?: LinkItemsResponse }>(`/v1/data-documents/${documentId}/tables/${tableId}/fields/${fieldId}/link-candidates`, { params: { q: query, limit } })
    .then(unwrapLinkItems)
}

export function listRecordHistory(documentId: number, tableId: number, recordId: number, params?: { limit?: number; offset?: number }) {
  return request
    .get<RecordHistoryResponse | { data?: RecordHistoryResponse }>(
      `/v1/data-documents/${documentId}/tables/${tableId}/records/${recordId}/history`,
      { params },
    )
    .then(unwrapResponseData<RecordHistoryResponse>)
}

export function uploadDataAttachment(documentId: number, tableId: number, file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return request
    .post<DataAttachment | { data?: DataAttachment }>(`/v1/data-documents/${documentId}/tables/${tableId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then(unwrapResponseData<DataAttachment>)
}

export function inferDataDocumentSchema(payload: { title?: string; prompt: string }) {
  return request
    .post<InferDataDocumentSchemaResponse | { data?: InferDataDocumentSchemaResponse }>('/v1/data-documents/ai/infer-schema', payload)
    .then(unwrapResponseData<InferDataDocumentSchemaResponse>)
}

export function exportDataTableMarkdown(documentId: number, tableId: number) {
  return request
    .get<{ content: string } | { data?: { content: string } }>(`/v1/data-documents/${documentId}/tables/${tableId}/export/markdown`)
    .then(unwrapResponseData<{ content: string }>)
}

export function importDataTableCSV(documentId: number, tableId: number, content: string) {
  return request
    .post<{ created: number } | { data?: { created: number } }>(`/v1/data-documents/${documentId}/tables/${tableId}/import/csv`, { content })
    .then(unwrapResponseData<{ created: number }>)
}

export function exportDataTableCSV(documentId: number, tableId: number) {
  return request.get<string>(`/v1/data-documents/${documentId}/tables/${tableId}/export/csv`)
}

const viewBase = (documentId: number, tableId: number, viewId: number) =>
  `/v1/data-documents/${documentId}/tables/${tableId}/views/${viewId}`

export function getViewSorts(documentId: number, tableId: number, viewId: number) {
  return request
    .get<ViewSortsResponse | { data?: ViewSortsResponse }>(`${viewBase(documentId, tableId, viewId)}/sorts`)
    .then(unwrapResponseData<ViewSortsResponse>)
}

export function putViewSorts(documentId: number, tableId: number, viewId: number, items: SortItem[]) {
  return request
    .put<ViewSortsResponse | { data?: ViewSortsResponse }>(`${viewBase(documentId, tableId, viewId)}/sorts`, { items })
    .then(unwrapResponseData<ViewSortsResponse>)
}

export function getViewGroups(documentId: number, tableId: number, viewId: number) {
  return request
    .get<ViewGroupsResponse | { data?: ViewGroupsResponse }>(`${viewBase(documentId, tableId, viewId)}/groups`)
    .then(unwrapResponseData<ViewGroupsResponse>)
}

export function putViewGroups(documentId: number, tableId: number, viewId: number, items: GroupItem[]) {
  return request
    .put<ViewGroupsResponse | { data?: ViewGroupsResponse }>(`${viewBase(documentId, tableId, viewId)}/groups`, { items })
    .then(unwrapResponseData<ViewGroupsResponse>)
}

export function listViewFields(documentId: number, tableId: number, viewId: number) {
  return request
    .get<ViewFieldsResponse | { data?: ViewFieldsResponse }>(`${viewBase(documentId, tableId, viewId)}/view-fields`)
    .then(unwrapResponseData<ViewFieldsResponse>)
}

export function patchViewField(
  documentId: number,
  tableId: number,
  viewId: number,
  fieldId: number,
  payload: ViewFieldPatchPayload
) {
  return request
    .patch<ViewFieldLayout | { data?: ViewFieldLayout }>(
      `${viewBase(documentId, tableId, viewId)}/view-fields/${fieldId}`,
      payload
    )
    .then(unwrapResponseData<ViewFieldLayout>)
}

export function bulkDeleteDataRecords(documentId: number, tableId: number, payload: BulkDeleteRecordsPayload) {
  return request
    .post<BulkDeleteRecordsResult | { data?: BulkDeleteRecordsResult }>(
      `/v1/data-documents/${documentId}/tables/${tableId}/records/bulk-delete`,
      payload
    )
    .then(unwrapResponseData<BulkDeleteRecordsResult>)
}

export function bulkCopyDataRecords(documentId: number, tableId: number, payload: BulkCopyRecordsPayload) {
  return request
    .post<BulkCopyRecordsResult | { data?: BulkCopyRecordsResult }>(
      `/v1/data-documents/${documentId}/tables/${tableId}/records/bulk-copy`,
      payload
    )
    .then(unwrapResponseData<BulkCopyRecordsResult>)
}
