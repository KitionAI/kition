import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DataField,
  DataFieldType,
  DataDocument,
  DataRecord,
  DataRecordValue,
  DataTable,
  DataView,
  LinkRef,
} from '@/types/dataDocument'
import { useTableDataSource } from '@/features/table/ports/TableDataSource'
import { useTableHost, useTableNotify } from '@/features/table/ports/TableHost'
import {
  DATA_TABLE_ACTION_EVENT,
  type TableActionEventDetail,
} from '@/features/table/lib/tableActions'
import {
  gridRecordOverscanRows,
  gridRecordPageSize,
  resolveGridRowHeight,
} from '@/features/table/lib/tableEditorShared'
import { buildTableLiveChangeHandlers } from '@/features/table/lib/tableLiveChangeDispatch'

import { TableColumnHeaderMenu } from './TableColumnHeaderMenu'
import { TableEditorContent } from './TableEditorContent'
import { TableEditorFooter } from './TableEditorFooter'
import { AttachmentPreviewModal } from './AttachmentPreviewModal'
import { TableEditorToolbar } from './TableEditorToolbar'
import { TableFileImportDialog } from './TableFileImportDialog'
import { FieldConfigPanel } from './TableFieldConfigPanel'
import { TableRecordContextMenu } from './TableRecordContextMenu'
import { RecordDetailDrawer } from './TableRecordDetailDrawer'
import { useApplyAICellPatches } from '../hooks/useApplyAICellPatches'
import { useTableClipboard } from '../hooks/useTableClipboard'
import { useTableColumnHeaderActions } from '../hooks/useTableColumnHeaderActions'
import { useTableEditorActions } from '../hooks/useTableEditorActions'
import { useGridCollapsedGroup } from '../hooks/useGridCollapsedGroup'
import { useTableEditorData } from '../hooks/useTableEditorData'
import { useTableEditorDerivedState } from '../hooks/useTableEditorDerivedState'
import { useTableEditorUiState } from '../hooks/useTableEditorUiState'
import { useTableHistory } from '../hooks/useTableHistory'
import { useTableLiveChanges } from '../ports/useTableLiveChanges'
import { useTableViewState } from '../hooks/useTableViewState'

export function TableEditor({
  agentOpen: controlledAgentOpen,
  aiCellPatches,
  documentPath,
  markerContent,
  pinnedTableId,
  onOpenDocument,
  onAgentContextChange,
  onAgentOpenChange,
  readOnly = false,
}: {
  agentOpen?: boolean
  /**
   * Optional list of AI-fill cell mutations to apply to the local
   * `records` state as new entries arrive. Used by the scenario build
   * flow (see `ScenarioBuildPage`) to stream `cell.ai.filled` events
   * straight into the visible grid without a refetch. The list is
   * append-only: callers should pass the same reference order across
   * renders so we can track an "applied" highwater mark via the patch
   * count. Each entry's `fieldId` is resolved against the active
   * table's fields to find the matching `field.name`, which is the
   * key inside `record.values`. Unknown record/field ids are silently
   * skipped (the orchestrator may emit an event a tick before the
   * frontend has refetched the corresponding row).
   */
  aiCellPatches?: ReadonlyArray<{
    recordId: number
    fieldId: number
    value: DataRecordValue
  }>
  documentPath: string
  markerContent: string
  pinnedTableId?: number
  onOpenDocument?: (path: string) => void
  onAgentContextChange?: (context: {
    documentPath: string
    activeDocument: DataDocument | null
    activeTable: DataTable | null
    onTableChanged?: () => Promise<void> | void
  }) => void
  onAgentOpenChange?: (open: boolean) => void
  /** A co-edited table this person may only view: no cell, record, field, or view changes. */
  readOnly?: boolean
}) {
  const { t } = useTranslation('table')
  const dataSource = useTableDataSource()
  const host = useTableHost()
  const notify = useTableNotify()
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const {
    clearKanbanDrag,
    closeColumnHeaderMenu,
    columnHeaderMenu,
    editingField,
    imagePreview,
    kanbanDragOverGroup,
    kanbanDragOverRecordId,
    kanbanDraggingRecordId,
    openColumnHeaderMenu,
    openRecordContextMenu,
    recordContextMenu,
    resetSelectedRecordIds,
    selectedGridCell,
    selectedRecord,
    selectedRecordIds,
    setEditingField,
    setImagePreview,
    setKanbanDragOverGroup,
    setKanbanDragOverRecordId,
    setKanbanDraggingRecordId,
    setRecordContextMenu,
    setSelectedGridCell,
    setSelectedRecord,
    setSelectedRecordIds,
    setToolbarPanel,
    toggleAllSelected,
    toggleRecordSelected,
    toolbarPanel,
  } = useTableEditorUiState()
  const {
    document,
    setDocument,
    activeTableId,
    activeViewId,
    setActiveViewId,
    records,
    setRecords,
    recordTotal,
    recordOffset,
    loading,
    error,
    setError,
    refreshDocument,
    loadRecords,
  } = useTableEditorData({
    documentPath,
    markerContent,
    pinnedTableId,
    onRecordsLoaded: resetSelectedRecordIds,
  })
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [newFieldTitle, setNewFieldTitle] = useState('')
  const [newFieldType, setNewFieldType] = useState<DataFieldType>('text')
  const [viewCreateOpen, setViewCreateOpen] = useState(false)
  const [uncontrolledAgentOpen, setUncontrolledAgentOpen] = useState(false)
  const agentOpen = typeof controlledAgentOpen === 'boolean'
    ? controlledAgentOpen
    : uncontrolledAgentOpen

  const activeTable = useMemo<DataTable | null>(() => {
    return (
      document?.tables?.find((table) => table.id === activeTableId) ||
      document?.tables?.[0] ||
      null
    )
  }, [document, activeTableId])
  const tableViews = useMemo(
    () => activeTable?.views || [],
    [activeTable?.views],
  )
  const activeView = useMemo<DataView | null>(() => {
    return (
      tableViews.find((view) => view.id === activeViewId) ||
      tableViews[0] ||
      null
    )
  }, [activeViewId, tableViews])
  const {
    coverFieldName,
    filterFieldName,
    filterOperator,
    filterTree,
    filterValue,
    frozenColumnCount,
    groupFieldName,
    groupItems,
    hiddenFieldNames,
    rowHeightKey,
    setCoverFieldName,
    setFilterFieldName,
    setFilterOperator,
    setFilterTree,
    setFilterValue,
    setFrozenColumnCount,
    setGroupFieldName,
    setGroupItems,
    setHiddenFieldNames,
    setRowHeightKey,
    setSortDirection,
    setSortFieldName,
    setSortItems,
    sortDirection,
    sortFieldName,
    sortItems,
    viewMode,
  } = useTableViewState({
    document,
    activeTable,
    activeView,
    tableViews,
    setDocument,
    setActiveViewId,
  })
  const fields = activeTable?.fields || []
  // Stream `cell.ai.filled` patches (from the scenario build flow) into
  // the local records state as soon as the table fields have loaded.
  // No-op when the scenario page doesn't pass `aiCellPatches`.
  useApplyAICellPatches({
    patches: aiCellPatches,
    fields,
    setRecords,
  })
  const { collapsedGroupIds, setCollapsedGroupIds } = useGridCollapsedGroup(activeView?.id ?? null)
  const {
    allVisibleSelected,
    canMoveKanbanCards,
    canReorderRows,
    canUseVirtualGrid,
    contextMenuRecord,
    coverField,
    coverFields,
    dateField,
    gridTableStyle,
    gridTotalRows,
    gridVirtualBlockTop,
    gridVirtualCanvasHeight,
    groupCollection,
    groupField,
    groupFieldNames,
    groupPoints,
    groupedRecords,
    groupableFields,
    numericSummaries,
    primaryField,
    renderedGridRecords,
    sortedAndFilteredRecords,
    visibleFields,
  } = useTableEditorDerivedState({
    fields,
    hiddenFieldNames,
    coverFieldName,
    filterFieldName,
    filterOperator,
    filterTree,
    filterValue,
    groupFieldName,
    groupItems,
    collapsedGroupIds,
    query,
    recordContextMenuRecordId: recordContextMenu?.recordId ?? null,
    recordOffset,
    records,
    recordTotal,
    selectedRecordIds,
    sortDirection,
    sortFieldName,
    sortItems,
    viewMode,
  })

  function setStatus(message: string) {
    notify.success(message)
  }

  async function refreshAgentChanges() {
    await refreshDocument(
      activeTable?.id ?? activeTableId,
      activeView?.id ?? activeViewId,
    )
    await loadRecords()
  }

  const documentId = document?.id ?? null
  const onApplyHistoryChange = useCallback(() => refreshAgentChanges(), [
    activeTable?.id,
    activeTableId,
    activeView?.id,
    activeViewId,
    refreshDocument,
    loadRecords,
  ])
  const {
    canUndo,
    canRedo,
    historyBusy,
    refreshHistoryState,
    undo,
    redo,
  } = useTableHistory({
    documentId,
    onApplyChange: onApplyHistoryChange,
  })

  useTableLiveChanges(documentId, buildTableLiveChangeHandlers({
    activeTableId: activeTable?.id ?? activeTableId,
    activeViewId: activeView?.id ?? activeViewId,
    loadRecords: () => void loadRecords(),
    refreshDocument: () => void refreshDocument(activeTable?.id ?? activeTableId, activeView?.id ?? activeViewId),
    refreshHistoryState,
  }))

  useEffect(() => {
    onAgentContextChange?.({
      documentPath,
      activeDocument: document,
      activeTable,
      onTableChanged:
        document && activeTable
          ? refreshAgentChanges
          : undefined,
    })

    return () => {
      onAgentContextChange?.({
        documentPath,
        activeDocument: null,
        activeTable: null,
      })
    }
  }, [
    activeTable,
    document,
    documentPath,
    onAgentContextChange,
  ])

  useEffect(() => {
    void loadRecords()
  }, [document?.id, activeTable?.id, viewMode])

  useEffect(() => {
    setEditingField(null)
  }, [activeTable?.id, setEditingField])

  useEffect(() => {
    const id = `table-sync:${activeTableId ?? 'unknown'}`
    if (!error || !documentId || !activeTableId) {
      notify.dismiss(id)
      return
    }
    notify.error(error, { id })
  }, [error, documentId, activeTableId, notify])
  const {
    addField,
    addDefaultField,
    addRecord,
    clearCells,
    createRecordFromValues,
    copyTextToClipboard,
    copyRecordURL,
    createView,
    deleteView,
    duplicateRecord,
    duplicateView,
    fillCells,
    insertRecordsNear,
    moveKanbanRecord,
    openAttachmentPreview,
    renameView,
    reorderField,
    removeField,
    removeRecord,
    removeSelectedRecords,
    duplicateSelectedRecords,
    reorderRecords,
    runAIField,
    runAIFieldBatchForRecords,
    runTableAction,
    saveField,
    updateCell,
  } = useTableEditorActions({
    documentPath,
    document,
    activeTable,
    tableViews,
    fields,
    records,
    groupField,
    canReorderRows,
    canMoveKanbanCards,
    newFieldTitle,
    newFieldType,
    selectedRecordIds,
    importInputRef,
    setBusy,
    setError,
    setDocument,
    setRecords,
    setSelectedRecord,
    setSelectedRecordIds,
    setRecordContextMenu,
    setEditingField,
    setNewFieldTitle,
    setViewCreateOpen,
    setActiveViewId,
    setImagePreview,
    refreshDocument,
    loadRecords,
    refreshHistoryState,
  })

  const columnActions = useTableColumnHeaderActions({
    document,
    activeTable,
    records,
    visibleFields,
    sortItems,
    setBusy,
    setError,
    setEditingField,
    setFilterTree,
    setSortItems,
    setGroupItems,
    setFrozenColumnCount,
    setHiddenFieldNames,
    setToolbarPanel,
    refreshDocument,
    copyTextToClipboard,
    setStatus,
    refreshHistoryState,
  })

  function handleColumnAIBatch(field: DataField) {
    const ids = sortedAndFilteredRecords.map((record) => record.id)
    void runAIFieldBatchForRecords(field, ids, 'column-menu')
  }

  useEffect(() => {
    function handleDataTableAction(event: Event) {
      const detail = (event as CustomEvent<TableActionEventDetail>).detail
      if (!detail || detail.documentPath !== documentPath) return
      runTableAction(detail.action)
    }

    window.addEventListener(DATA_TABLE_ACTION_EVENT, handleDataTableAction)
    return () =>
      window.removeEventListener(DATA_TABLE_ACTION_EVENT, handleDataTableAction)
  }, [documentPath, runTableAction])

  const { pasteRecords } = useTableClipboard({
    documentId: document?.id,
    tableId: activeTable?.id,
    viewMode,
    visibleFields,
    sortedAndFilteredRecords,
    records,
    selectedGridCell,
    setBusy,
    setError,
    setStatus,
    setRecords,
    reloadRecords: () => {
      void loadRecords()
    },
    refreshHistoryState,
  })

  function closeRecordContextMenu() {
    setRecordContextMenu(null)
  }

  function setAgentOpen(nextOpen: boolean | ((open: boolean) => boolean)) {
    const resolvedNextOpen = typeof nextOpen === 'function'
      ? nextOpen(agentOpen)
      : nextOpen
    if (typeof controlledAgentOpen !== 'boolean') {
      setUncontrolledAgentOpen(resolvedNextOpen)
    }
    onAgentOpenChange?.(resolvedNextOpen)
  }

  async function copyRecordValuesForChat(record: DataRecord) {
    await copyTextToClipboard(
      JSON.stringify(record.values || {}, null, 2),
      t('editor.recordCopiedForChat'),
    )
  }

  async function handleFormSubmit(values: Record<string, DataRecordValue>) {
    setBusy(true)
    try {
      const record = await createRecordFromValues(values)
      if (!record) return
      const gridView = tableViews.find((view) => view.type === 'grid')
      if (gridView) setActiveViewId(gridView.id)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : t('editor.createRecordFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  /** `run`, or nothing at all for a table this person may only view. */
  const viewOnly = <F extends (...args: never[]) => unknown>(run: F): F => (
    readOnly ? ((() => undefined) as unknown as F) : run
  )
  const shownFields = readOnly ? fields.map((field) => ({ ...field, readonly: true })) : fields
  const shownVisibleFields = readOnly ? visibleFields.map((field) => ({ ...field, readonly: true })) : visibleFields

  if (loading) {
    return (
      <div
        data-testid="table-editor-skeleton"
        aria-busy="true"
        aria-label={t('editor.loadingTable')}
        className="flex h-full w-full flex-col gap-3 p-4"
      >
        <div className="flex items-center gap-2">
          <span className="skeleton h-7 w-32" />
          <span className="skeleton h-7 w-20" />
          <span className="skeleton ml-auto h-7 w-24" />
        </div>
        <div className="skeleton h-9 w-full" />
        {Array.from({ length: 8 }).map((_, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <span className="skeleton h-5 w-6" />
            <span className="skeleton h-5 flex-[2]" />
            <span className="skeleton h-5 flex-1" />
            <span className="skeleton h-5 flex-1" />
            <span className="skeleton h-5 flex-[1.5]" />
          </div>
        ))}
      </div>
    )
  }

  if (!document || !activeTable) {
    return (
      <div className="data-inline-state">{error || t('editor.tableNotFound')}</div>
    )
  }

  return (
    <div className="data-inline-shell" data-testid="kitable-editor" data-read-only={readOnly ? 'true' : undefined}>
      {host.fileImport ? (
        <input
          ref={importInputRef}
          type="file"
          accept=".csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(event) => {
            setImportFile(event.target.files?.[0] || null)
            event.currentTarget.value = ''
          }}
        />
      ) : null}
      <TableFileImportDialog
        open={Boolean(importFile)}
        file={importFile}
        target={{ kind: 'existing_table', documentId: document.id, table: activeTable }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setImportFile(null)
        }}
        onCompleted={async (result) => {
          await refreshDocument(activeTable.id)
          await loadRecords()
          notify.success(t('fileImport.completedSummary', {
            fields: result.fields_created + result.fields_updated,
            rows: result.rows_created + result.rows_updated,
          }))
        }}
      />
      <div className="data-inline-editor">
        <TableEditorToolbar
          tableViews={tableViews}
          activeViewId={activeView?.id ?? null}
          onSelectView={(viewId) => {
            setActiveViewId(viewId)
            setViewCreateOpen(false)
          }}
          viewCreateOpen={viewCreateOpen}
          onToggleViewCreate={() => setViewCreateOpen((open) => !open)}
          onCloseViewCreate={() => setViewCreateOpen(false)}
          onCreateView={viewOnly((type) => void createView(type))}
          onRenameView={viewOnly((viewId, nextTitle) => void renameView(viewId, nextTitle))}
          onDuplicateView={viewOnly((viewId) => void duplicateView(viewId))}
          onDeleteView={viewOnly((viewId) => void deleteView(viewId))}
          busy={busy || historyBusy || readOnly}
          fields={fields}
          hiddenFieldNames={hiddenFieldNames}
          onResetHiddenFields={viewOnly(() => setHiddenFieldNames(new Set()))}
          onToggleFieldVisibility={viewOnly((fieldName, checked) => {
            setHiddenFieldNames((current) => {
              const next = new Set(current)
              if (checked) next.delete(fieldName)
              else next.add(fieldName)
              return next
            })
          })}
          onEditField={viewOnly(setEditingField)}
          onDuplicateField={viewOnly(columnActions.duplicateField)}
          onDeleteField={viewOnly(removeField)}
          onAddDefaultField={viewOnly(() => void addDefaultField())}
          filterTree={filterTree}
          onFilterTreeChange={viewOnly(setFilterTree)}
          sortItems={sortItems}
          onSortItemsChange={viewOnly(setSortItems)}
          groupableFields={groupableFields}
          groupItems={groupItems}
          onGroupItemsChange={viewOnly(setGroupItems)}
          viewMode={viewMode}
          coverFieldName={coverFieldName}
          coverField={coverField}
          coverFields={coverFields}
          onCoverFieldNameChange={viewOnly(setCoverFieldName)}
          onResetCoverField={viewOnly(() => setCoverFieldName(''))}
          rowHeightKey={rowHeightKey}
          onRowHeightKeyChange={viewOnly(setRowHeightKey)}
          frozenColumnCount={frozenColumnCount}
          onFrozenColumnCountChange={viewOnly(setFrozenColumnCount)}
          toolbarPanel={toolbarPanel}
          onToolbarPanelChange={setToolbarPanel}
          newFieldTitle={newFieldTitle}
          newFieldType={newFieldType}
          onNewFieldTitleChange={setNewFieldTitle}
          onNewFieldTypeChange={setNewFieldType}
          onAddField={viewOnly(() => {
            void addField()
            setToolbarPanel(null)
          })}
          selectedRecordCount={selectedRecordIds.size}
          onRemoveSelectedRecords={viewOnly(() => void removeSelectedRecords())}
          onDuplicateSelectedRecords={viewOnly(() => void duplicateSelectedRecords())}
          agentOpen={agentOpen}
          onToggleAgent={() => setAgentOpen((open) => !open)}
          agentDisabled={!document || !activeTable}
          query={query}
          onQueryChange={setQuery}
          onAddRecord={viewOnly(() => void addRecord())}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={viewOnly(() => void undo())}
          onRedo={viewOnly(() => void redo())}
        />

        <TableEditorContent
          documentId={document.id}
          tableId={activeTable.id}
          viewId={activeView.id}
          viewMode={viewMode}
          fields={shownFields}
          visibleFields={shownVisibleFields}
          groupField={groupField}
          groupedRecords={groupedRecords}
          groupPoints={groupPoints}
          groupCollection={groupCollection}
          collapsedGroupIds={collapsedGroupIds}
          onCollapsedGroupChanged={setCollapsedGroupIds}
          primaryField={primaryField}
          dateField={dateField}
          coverField={coverField}
          sortedAndFilteredRecords={sortedAndFilteredRecords}
          renderedGridRecords={renderedGridRecords}
          groupFieldName={groupFieldName}
          groupFieldNames={groupFieldNames}
          selectedRecordIds={selectedRecordIds}
          selectedGridCell={selectedGridCell}
          canMoveKanbanCards={canMoveKanbanCards}
          canReorderRows={canReorderRows}
          canUseVirtualGrid={canUseVirtualGrid}
          gridVirtualCanvasHeight={gridVirtualCanvasHeight}
          gridVirtualBlockTop={gridVirtualBlockTop}
          gridTableStyle={gridTableStyle}
          recordOffset={recordOffset}
          recordTotal={recordTotal}
          pageSize={gridRecordPageSize}
          overscanRows={gridRecordOverscanRows}
          allVisibleSelected={allVisibleSelected}
          resetScrollKey={`${document.id}:${activeTable.id}:${viewMode}`}
          rowHeight={resolveGridRowHeight(rowHeightKey)}
          freezeColumnCount={frozenColumnCount}
          searchQuery={query}
          onColumnFreeze={viewOnly(setFrozenColumnCount)}
          draggingRecordId={kanbanDraggingRecordId}
          dragOverRecordId={kanbanDragOverRecordId}
          dragOverGroup={kanbanDragOverGroup}
          onDragStart={setKanbanDraggingRecordId}
          onDragEnd={clearKanbanDrag}
          onDragOverRecord={setKanbanDragOverRecordId}
          onDragOverGroup={setKanbanDragOverGroup}
          onMoveKanbanRecord={viewOnly((recordId, group, targetRecordId) =>
            void moveKanbanRecord(recordId, group, targetRecordId)
          )}
          onAddRecord={viewOnly((initialValues) => void addRecord(initialValues))}
          onOpenRecord={setSelectedRecord}
          onOpenDocument={onOpenDocument}
          onPreviewAttachments={openAttachmentPreview}
          onSubmitForm={viewOnly(handleFormSubmit)}
          onLoadWindow={(window) => void loadRecords(window)}
          onToggleAllSelected={() =>
            toggleAllSelected(
              sortedAndFilteredRecords.map((record) => record.id),
              allVisibleSelected,
            )
          }
          onToggleRecordSelected={toggleRecordSelected}
          onSelectCell={setSelectedGridCell}
          onOpenRecordContextMenu={openRecordContextMenu}
          onOpenColumnHeaderMenu={openColumnHeaderMenu}
          onReorderField={viewOnly((field, fromIndex, dropIndex) => {
            void reorderField(field, fromIndex, dropIndex, visibleFields)
          })}
          onReorderRecords={viewOnly((sourceRecordId, targetRecordId, position) =>
            void reorderRecords(sourceRecordId, targetRecordId, position)
          )}
          onRegenerate={host.ai ? viewOnly((record, field) => void runAIField(record, field)) : undefined}
          onUpdateCell={viewOnly((record, field, value) =>
            void updateCell(record, field, value)
          )}
          onClearCells={viewOnly((cells) => void clearCells(cells))}
          onFillCells={viewOnly((cells) => void fillCells(cells))}
          onPaste={viewOnly((event) => void pasteRecords(event))}
          onOpenFieldCreator={viewOnly(() => void addDefaultField())}
          onUndo={viewOnly(() => void undo())}
          onRedo={viewOnly(() => void redo())}
        />
        <TableRecordContextMenu
          menu={
            recordContextMenu
              ? { x: recordContextMenu.x, y: recordContextMenu.y }
              : null
          }
          record={contextMenuRecord}
          busy={busy}
          canInsert={canReorderRows}
          fields={fields}
          selectedFieldName={
            selectedGridCell && contextMenuRecord
            && selectedGridCell.recordId === contextMenuRecord.id
              ? selectedGridCell.fieldName
              : null
          }
          onClose={closeRecordContextMenu}
          onInsertRecords={viewOnly((record, count, position) =>
            insertRecordsNear(record, count, position)
          )}
          onDuplicateRecord={viewOnly(duplicateRecord)}
          onCopyRecordURL={copyRecordURL}
          onOpenRecord={setSelectedRecord}
          onCopyRecordForChat={copyRecordValuesForChat}
          onDeleteRecord={viewOnly(removeRecord)}
          onRegenerateAIField={viewOnly((record, field) => void runAIField(record, field))}
          onStatus={setStatus}
        />
        <TableColumnHeaderMenu
          menu={
            columnHeaderMenu
              ? { x: columnHeaderMenu.x, y: columnHeaderMenu.y }
              : null
          }
          field={
            columnHeaderMenu
              ? fields.find((item) => item.id === columnHeaderMenu.fieldId) ?? null
              : null
          }
          busy={busy}
          onClose={closeColumnHeaderMenu}
          onEditField={viewOnly(setEditingField)}
          onDuplicateField={viewOnly(columnActions.duplicateField)}
          onRunAIBatch={viewOnly(handleColumnAIBatch)}
          onDownloadAllFiles={columnActions.downloadAllFiles}
          onAddColumnToChat={columnActions.copyColumnValuesForChat}
          onInsertField={viewOnly(columnActions.insertField)}
          onAddFilterForField={viewOnly(columnActions.addFilterForField)}
          onAddSortForField={viewOnly(columnActions.addSortForField)}
          onSetGroupField={viewOnly(columnActions.setGroupField)}
          onFreezeUpTo={viewOnly(columnActions.freezeUpToField)}
          onHideField={viewOnly(columnActions.hideField)}
          onDeleteField={viewOnly(removeField)}
        />
        <TableEditorFooter
          gridTotalRows={gridTotalRows}
          canUseVirtualGrid={canUseVirtualGrid}
          recordOffset={recordOffset}
          loadedRecordCount={records.length}
          recordTotal={recordTotal}
          numericSummaries={numericSummaries}
          selectedRecordCount={selectedRecordIds.size}
        />
      </div>

      {editingField ? (
        <FieldConfigPanel
          field={editingField}
          fields={fields}
          busy={busy}
          onClose={() => setEditingField(null)}
          onSave={viewOnly((updates) => saveField(editingField, updates))}
        />
      ) : null}

      {selectedRecord ? (() => {
        const navList = sortedAndFilteredRecords
        const navIndex = navList.findIndex((item) => item.id === selectedRecord.id)
        const canPrev = navIndex > 0
        const canNext = navIndex >= 0 && navIndex < navList.length - 1
        return (
          <RecordDetailDrawer
            record={
              records.find((record) => record.id === selectedRecord.id) ||
              selectedRecord
            }
            fields={shownFields}
            primaryField={primaryField}
            documentId={document.id}
            tableId={activeTable.id}
            navIndex={navIndex >= 0 ? navIndex : undefined}
            navTotal={navList.length || undefined}
            canNavigatePrev={canPrev}
            canNavigateNext={canNext}
            onNavigatePrev={canPrev ? () => setSelectedRecord(navList[navIndex - 1]) : undefined}
            onNavigateNext={canNext ? () => setSelectedRecord(navList[navIndex + 1]) : undefined}
            onPreviewAttachments={openAttachmentPreview}
            onOpenDocument={onOpenDocument}
            onClose={() => setSelectedRecord(null)}
            onDelete={viewOnly(() => {
              void removeRecord(selectedRecord.id)
              setSelectedRecord(null)
            })}
            onUpdate={viewOnly((field, value) =>
              void updateCell(selectedRecord, field, value)
            )}
            onReplaceLinks={viewOnly(async (field: DataField, rowKeys: string[]): Promise<LinkRef[] | null> => {
              try {
                const refs = await dataSource.links.replace({
                  documentId: document.id,
                  tableId: activeTable.id,
                  recordId: selectedRecord.id,
                  field_id: field.id,
                  target_row_keys: rowKeys,
                })
                setRecords((items) =>
                  items.map((record) =>
                    record.id === selectedRecord.id
                      ? { ...record, values: { ...(record.values || {}), [field.name]: refs } }
                      : record,
                  ),
                )
                return refs
              } catch (error) {
                console.error('replaceRecordLinks failed', error)
                notify.error(t('editor.replaceLinksFailed'), {
                  description: error instanceof Error ? error.message : String(error),
                })
                return null
              }
            })}
          />
        )
      })() : null}

      <AttachmentPreviewModal
        open={Boolean(imagePreview)}
        items={imagePreview?.items ?? []}
        index={imagePreview?.index ?? 0}
        onClose={() => setImagePreview(null)}
        onIndexChange={(nextIndex) =>
          setImagePreview((current) =>
            current ? { ...current, index: nextIndex } : current,
          )
        }
      />
    </div>
  )
}
