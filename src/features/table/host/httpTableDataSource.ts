import {
  bulkCopyDataRecords,
  bulkDeleteDataRecords,
  createDataField,
  createDataRecord,
  createDataTable,
  createDataView,
  deleteDataField,
  deleteDataRecord,
  deleteDataTable,
  deleteDataView,
  duplicateDataField,
  exportDataTableCSV,
  getDataDocument,
  getDataDocumentHistoryState,
  listDataDashboards,
  listDataDocuments,
  listDataRecords,
  listLinkCandidates,
  listRecordHistory,
  listViewFields,
  openDataDocumentByPath,
  patchViewField,
  putDataDashboard,
  redoDataDocument,
  replaceRecordLinks,
  transactDataDocument,
  undoDataDocument,
  updateDataField,
  updateDataRecord,
  updateDataTable,
  updateDataView,
} from '@/api/dataDocuments'
import { windowSessionOrigin } from '@/api/windowSession'
import { onTableChanged, onTableChangedResync } from '@/services/runtimeBridge'
import type { TableDataSource } from '@/features/table/ports/TableDataSource'

/**
 * Kition's table data: the runtime's `/v1/data-documents` routes over HTTP, and its
 * `table/changed` events on the kit bridge stream. Events for another document, and events
 * this window caused itself (`origin` is this window's own `person:session:<uuid>`, already
 * applied locally), are not reported.
 */
export const httpTableDataSource: TableDataSource = {
  documents: {
    get: ({ documentId }) => getDataDocument(documentId),
    open: (params) => openDataDocumentByPath(params),
    list: (params) => listDataDocuments(params),
  },
  tables: {
    create: ({ documentId, ...payload }) => createDataTable(documentId, payload),
    update: ({ documentId, tableId, ...payload }) => updateDataTable(documentId, tableId, payload),
    delete: ({ documentId, tableId }) => deleteDataTable(documentId, tableId),
  },
  fields: {
    create: ({ documentId, tableId, ...payload }) => createDataField(documentId, tableId, payload),
    update: ({ documentId, tableId, fieldId, ...payload }) => updateDataField(documentId, tableId, fieldId, payload),
    delete: ({ documentId, tableId, fieldId }) => deleteDataField(documentId, tableId, fieldId),
    duplicate: ({ documentId, tableId, fieldId }) => duplicateDataField(documentId, tableId, fieldId),
    linkCandidates: ({ documentId, tableId, fieldId, q, limit }) => listLinkCandidates(documentId, tableId, fieldId, q, limit),
  },
  views: {
    create: ({ documentId, tableId, ...payload }) => createDataView(documentId, tableId, payload),
    update: ({ documentId, tableId, viewId, ...payload }) => updateDataView(documentId, tableId, viewId, payload),
    delete: ({ documentId, tableId, viewId }) => deleteDataView(documentId, tableId, viewId),
    listFields: ({ documentId, tableId, viewId }) => listViewFields(documentId, tableId, viewId),
    patchField: ({ documentId, tableId, viewId, fieldId, ...payload }) => (
      patchViewField(documentId, tableId, viewId, fieldId, payload)
    ),
  },
  records: {
    list: ({ documentId, tableId, ...window }) => (
      listDataRecords(documentId, tableId, Object.keys(window).length ? window : undefined)
    ),
    create: ({ documentId, tableId, values }) => createDataRecord(documentId, tableId, values),
    update: ({ documentId, tableId, recordId, values }) => updateDataRecord(documentId, tableId, recordId, values),
    delete: ({ documentId, tableId, recordId }) => deleteDataRecord(documentId, tableId, recordId),
    history: ({ documentId, tableId, recordId, ...window }) => listRecordHistory(documentId, tableId, recordId, window),
    bulkDelete: ({ documentId, tableId, ...payload }) => bulkDeleteDataRecords(documentId, tableId, payload),
    bulkCopy: ({ documentId, tableId, ...payload }) => bulkCopyDataRecords(documentId, tableId, payload),
  },
  links: {
    replace: ({ documentId, tableId, recordId, field_id, target_row_keys }) => (
      replaceRecordLinks(documentId, tableId, recordId, field_id, target_row_keys)
    ),
  },
  csv: {
    export: ({ documentId, tableId }) => exportDataTableCSV(documentId, tableId),
  },
  transact: ({ documentId, ops }) => transactDataDocument(documentId, ops),
  undo: ({ documentId }) => undoDataDocument(documentId),
  redo: ({ documentId }) => redoDataDocument(documentId),
  historyState: ({ documentId }) => getDataDocumentHistoryState(documentId),
  dashboards: {
    list: ({ documentId }) => listDataDashboards(documentId),
    upsert: ({ documentId, dashboardId, ...dashboard }) => putDataDashboard(documentId, { ...dashboard, id: dashboardId }),
  },
  onChange(documentId, listener) {
    const expectedDocumentId = String(documentId)
    const ownOrigin = windowSessionOrigin()
    const unsubscribeChanged = onTableChanged((change) => {
      if (change.documentId !== expectedDocumentId) return
      if (change.origin === ownOrigin) return
      listener({ type: 'changed', change })
    })
    const unsubscribeResync = onTableChangedResync(() => listener({ type: 'resync' }))
    return () => {
      unsubscribeChanged()
      unsubscribeResync()
    }
  },
}
