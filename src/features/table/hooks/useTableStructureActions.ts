import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@/components/confirm'
import {
  createDataField,
  createDataRecord,
  createDataTable,
  createDataView,
  deleteDataField,
  deleteDataTable,
  exportDataTableCSV,
  importDataTableCSV,
  updateDataField,
  updateDataTable,
  updateDataView,
} from '@/api/dataDocuments'
import { saveTextFile } from '@/services/desktop'
import type {
  DataDocument,
  DataField,
  DataFieldOptions,
  DataFieldSeed,
  DataFieldType,
  DataRecord,
  DataTable,
  DataView,
  DataViewSeed,
} from '@/types/dataDocument'
import {
  nextViewTitle,
  type DataInlineViewMode,
  type DataRecordWindow,
} from '@/features/table/lib/tableEditorShared'
import { reorderTableFields } from '@/features/table/lib/tableColumnOrdering'
import type { TableAction } from '@/features/table/lib/tableActions'

type UseTableStructureActionsArgs = {
  documentPath: string
  document: DataDocument | null
  activeTable: DataTable | null
  tableViews: DataView[]
  fields: DataField[]
  records: DataRecord[]
  newFieldTitle: string
  newFieldType: DataFieldType
  importInputRef: RefObject<HTMLInputElement | null>
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setDocument: Dispatch<SetStateAction<DataDocument | null>>
  setRecords: Dispatch<SetStateAction<DataRecord[]>>
  setEditingField: Dispatch<SetStateAction<DataField | null>>
  setNewFieldTitle: Dispatch<SetStateAction<string>>
  setViewCreateOpen: Dispatch<SetStateAction<boolean>>
  setActiveViewId: Dispatch<SetStateAction<number | null>>
  refreshDocument: (preferredTableId?: number | null, preferredViewId?: number | null) => Promise<void>
  loadRecords: (window?: DataRecordWindow) => Promise<void>
  setStatus: (message: string) => void
  copyTextToClipboard: (text: string, successMessage: string) => Promise<void>
}

export function useTableStructureActions({
  documentPath,
  document,
  activeTable,
  tableViews,
  fields,
  records,
  newFieldTitle,
  newFieldType,
  importInputRef,
  setBusy,
  setError,
  setDocument,
  setRecords,
  setEditingField,
  setNewFieldTitle,
  setViewCreateOpen,
  setActiveViewId,
  refreshDocument,
  loadRecords,
  setStatus,
  copyTextToClipboard,
}: UseTableStructureActionsArgs) {
  const confirm = useConfirm()
  const { t } = useTranslation('table')
  const { t: tw } = useTranslation('workspace')

  function makeDuplicateFieldSeed(field: DataField): DataFieldSeed {
    return {
      title: field.title,
      name: field.name,
      type: field.type,
      primary: field.is_primary,
      required: field.required,
      readonly: field.readonly,
      options: field.options,
      formula: field.formula,
    }
  }

  function makeDuplicateViewSeed(view: DataView): DataViewSeed {
    return {
      title: view.title,
      type: view.type,
      config: view.config,
    }
  }

  async function renameActiveTable(nextTitleValue: string) {
    if (!document || !activeTable) return
    const currentTitle = activeTable.title
    const nextTitle = nextTitleValue.trim()
    if (!nextTitle || nextTitle === currentTitle) return
    try {
      const updatedTable = await updateDataTable(document.id, activeTable.id, { title: nextTitle })
      setDocument((current) => current ? {
        ...current,
        tables: current.tables?.map((table) => (
          table.id === updatedTable.id ? { ...table, ...updatedTable } : table
        )) || [],
      } : current)
      window.dispatchEvent(new CustomEvent('kition:data-document:table:rename', {
        detail: { vaultPath: documentPath, tableId: activeTable.id, newName: updatedTable.title },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save table name')
    }
  }

  async function duplicateActiveTable() {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      const created = await createDataTable(document.id, {
        title: `${activeTable.title} copy`,
        description: activeTable.description,
        fields: fields.map(makeDuplicateFieldSeed),
        views: tableViews.map(makeDuplicateViewSeed),
      })
      if (records.length) {
        await Promise.all(records.map((record) => createDataRecord(document.id, created.id, record.values || {})))
      }
      window.dispatchEvent(new CustomEvent('kition:data-document:table:create', {
        detail: { vaultPath: documentPath, tableId: created.id },
      }))
      await refreshDocument(created.id)
      setStatus(t('feedback.tableDuplicated'))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to duplicate table')
    } finally {
      setBusy(false)
    }
  }

  async function downloadActiveTableCSV() {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      const content = await exportDataTableCSV(document.id, activeTable.id)
      await saveTextFile({
        dialogTitle: 'Download CSV',
        defaultFilename: `${document.title}-${activeTable.title}.csv`,
        content,
      })
      setStatus(t('feedback.csvDownloaded'))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to export CSV')
    } finally {
      setBusy(false)
    }
  }

  async function importCSVFile(file?: File) {
    if (!file || !document || !activeTable) return
    setBusy(true)
    try {
      const content = await file.text()
      const result = await importDataTableCSV(document.id, activeTable.id, content)
      await loadRecords()
      setStatus(`Imported ${result.created} records`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to import CSV')
    } finally {
      setBusy(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  async function deleteActiveTable() {
    if (!document || !activeTable) return
    if (!(await confirm({ message: `Delete table "${activeTable.title}"?`, variant: 'destructive' }))) return
    setBusy(true)
    try {
      await deleteDataTable(document.id, activeTable.id)
      window.dispatchEvent(new CustomEvent('kition:data-document:table:delete', {
        detail: { vaultPath: documentPath, tableId: activeTable.id },
      }))
      await refreshDocument(null)
      setRecords([])
      setStatus(t('feedback.tableDeleted'))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to delete table')
    } finally {
      setBusy(false)
    }
  }

  function runTableAction(action: TableAction) {
    if (action === 'rename') {
      const nextTitle = window.prompt(tw('itemMenu.tableAction.rename'), activeTable?.title || '')
      if (nextTitle !== null) void renameActiveTable(nextTitle)
      return
    }
    if (action === 'duplicate') {
      void duplicateActiveTable()
      return
    }
    if (action === 'download_csv') {
      void downloadActiveTableCSV()
      return
    }
    if (action === 'import_csv') {
      importInputRef.current?.click()
      return
    }
    if (action === 'copy_api') {
      if (document && activeTable) {
        void copyTextToClipboard(`/v1/data-documents/${document.id}/tables/${activeTable.id}`, 'API path copied')
      }
      return
    }
    if (action === 'history') {
      setStatus(t('feedback.historyUnavailable'))
      return
    }
    if (action === 'share') {
      const shareText = document?.path || documentPath
      void copyTextToClipboard(shareText, 'Table link copied')
      return
    }
    if (action === 'delete') {
      void deleteActiveTable()
    }
  }

  async function createView(type: DataInlineViewMode) {
    if (!document || !activeTable) return
    setBusy(true)
    setViewCreateOpen(false)
    try {
      const view = await createDataView(document.id, activeTable.id, {
        title: nextViewTitle(type, tableViews),
        type,
      })
      setDocument((current) => current ? {
        ...current,
        tables: current.tables?.map((table) => table.id === activeTable.id ? {
          ...table,
          views: [...(table.views || []), view].sort((first, second) => first.order - second.order || first.id - second.id),
        } : table),
      } : current)
      setActiveViewId(view.id)
      window.dispatchEvent(new CustomEvent('kition:data-document:view:upsert', {
        detail: { vaultPath: documentPath, tableId: activeTable.id, viewId: view.id },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to create view')
    } finally {
      setBusy(false)
    }
  }

  async function renameView(viewId: number, nextTitleValue: string) {
    if (!document || !activeTable) return
    const view = tableViews.find((item) => item.id === viewId)
    const nextTitle = nextTitleValue.trim()
    if (!view || !nextTitle || nextTitle === view.title) return
    try {
      const updated = await updateDataView(document.id, activeTable.id, viewId, { title: nextTitle })
      setDocument((current) => current ? {
        ...current,
        tables: current.tables?.map((table) => table.id === activeTable.id ? {
          ...table,
          views: table.views?.map((item) => item.id === viewId ? updated : item),
        } : table),
      } : current)
      window.dispatchEvent(new CustomEvent('kition:data-document:view:upsert', {
        detail: { vaultPath: documentPath, tableId: activeTable.id, viewId },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to rename view')
    }
  }

  async function addField() {
    if (!document || !activeTable || !newFieldTitle.trim()) return
    setBusy(true)
    try {
      await createDataField(document.id, activeTable.id, {
        title: newFieldTitle.trim(),
        type: newFieldType,
        readonly: newFieldType === 'formula',
        options: newFieldType === 'single_select' || newFieldType === 'multi_select'
          ? { choices: ['Not started', 'In progress', 'Done'] }
          : undefined,
      })
      setNewFieldTitle('')
      await refreshDocument(activeTable.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to add property')
    } finally {
      setBusy(false)
    }
  }

  async function addDefaultField() {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      const existingTitles = new Set(fields.map((field) => field.title))
      let title = 'New property'
      let counter = 2
      while (existingTitles.has(title)) {
        title = `New property ${counter++}`
      }
      await createDataField(document.id, activeTable.id, {
        title,
        type: 'text',
      })
      await refreshDocument(activeTable.id)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to add property')
    } finally {
      setBusy(false)
    }
  }

  async function saveField(field: DataField, updates: {
    title?: string
    type?: DataFieldType
    required?: boolean
    readonly?: boolean
    options?: DataFieldOptions | null
    formula?: string
  }) {
    if (!document || !activeTable) return
    try {
      const updated = await updateDataField(document.id, activeTable.id, field.id, updates)
      setDocument((current) => current ? {
        ...current,
        tables: current.tables?.map((table) => table.id === activeTable.id ? {
          ...table,
          fields: table.fields?.map((item) => item.id === field.id ? updated : item),
        } : table),
      } : current)
      setEditingField(updated)
      window.dispatchEvent(new CustomEvent('kition:data-document:field:upsert', {
        detail: { vaultPath: documentPath, tableId: activeTable.id, fieldId: field.id },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save field')
    }
  }

  async function reorderField(
    field: DataField,
    fromIndex: number,
    dropIndex: number,
    visibleFields: DataField[],
  ) {
    if (!document || !activeTable || visibleFields[fromIndex]?.id !== field.id) return
    const reorderedFields = reorderTableFields(fields, visibleFields, field.id, dropIndex)
    if (reorderedFields === fields) return

    const currentOrderById = new Map(fields.map((item) => [item.id, item.order]))
    const changedFields = reorderedFields.filter((item) => (
      currentOrderById.get(item.id) !== item.order
    ))
    if (!changedFields.length) return

    setBusy(true)
    setDocument((current) => current ? {
      ...current,
      tables: current.tables?.map((table) => table.id === activeTable.id ? {
        ...table,
        fields: reorderedFields,
      } : table),
    } : current)

    try {
      for (const item of changedFields) {
        await updateDataField(document.id, activeTable.id, item.id, { order: item.order })
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to reorder field')
      try {
        await refreshDocument(activeTable.id)
      } catch {
        // Keep the original request error visible if recovery also fails.
      }
    } finally {
      setBusy(false)
    }
  }

  async function removeField(field: DataField) {
    if (!document || !activeTable || field.is_primary) return
    setBusy(true)
    try {
      await deleteDataField(document.id, activeTable.id, field.id)
      setEditingField(null)
      await refreshDocument(activeTable.id)
      void loadRecords()
      window.dispatchEvent(new CustomEvent('kition:data-document:field:delete', {
        detail: { vaultPath: documentPath, tableId: activeTable.id, fieldId: field.id },
      }))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to delete field')
    } finally {
      setBusy(false)
    }
  }

  return {
    addField,
    addDefaultField,
    createView,
    importCSVFile,
    renameView,
    reorderField,
    removeField,
    runTableAction,
    saveField,
  }
}
