import { useEffect, useMemo, useRef, useState } from 'react'
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
import { replaceRecordLinks } from '@/api/dataDocuments'
import { notify } from '@/lib/notify'
import {
  DATA_TABLE_ACTION_EVENT,
  type TableActionEventDetail,
} from '@/features/table/lib/tableActions'
import {
  gridRecordOverscanRows,
  gridRecordPageSize,
  resolveGridRowHeight,
} from '@/features/table/lib/tableEditorShared'

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
import { useTableCellHistory } from '../hooks/useTableCellHistory'
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
}) {
  const { t } = useTranslation('table')
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

  const documentId = document?.id
  useEffect(() => {
    const id = `table-sync:${activeTableId ?? 'unknown'}`
    if (!error || !documentId || !activeTableId) {
      notify.dismiss(id)
      return
    }
    notify.error(error, { id })
  }, [error, documentId, activeTableId])
  const {
    addField,
    addDefaultField,
    addRecord,
    clearCells,
    createRecordFromValues,
    copyTextToClipboard,
    copyRecordURL,
    createView,
    duplicateRecord,
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
  })

  const {
    canUndo,
    canRedo,
    historyBusy,
    updateCellWithHistory,
    undo,
    redo,
  } = useTableCellHistory({
    fields,
    records,
    resetKey: `${document?.id ?? 'none'}:${activeTable?.id ?? 'none'}`,
    updateCell,
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
    <div className="data-inline-shell" data-testid="kitable-editor">
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
          onCreateView={(type) => void createView(type)}
          onRenameView={(viewId, nextTitle) => void renameView(viewId, nextTitle)}
          busy={busy || historyBusy}
          fields={fields}
          hiddenFieldNames={hiddenFieldNames}
          onResetHiddenFields={() => setHiddenFieldNames(new Set())}
          onToggleFieldVisibility={(fieldName, checked) => {
            setHiddenFieldNames((current) => {
              const next = new Set(current)
              if (checked) next.delete(fieldName)
              else next.add(fieldName)
              return next
            })
          }}
          onEditField={setEditingField}
          onDuplicateField={columnActions.duplicateField}
          onDeleteField={removeField}
          onAddDefaultField={() => void addDefaultField()}
          filterTree={filterTree}
          onFilterTreeChange={setFilterTree}
          sortItems={sortItems}
          onSortItemsChange={setSortItems}
          groupableFields={groupableFields}
          groupItems={groupItems}
          onGroupItemsChange={setGroupItems}
          viewMode={viewMode}
          coverFieldName={coverFieldName}
          coverField={coverField}
          coverFields={coverFields}
          onCoverFieldNameChange={setCoverFieldName}
          onResetCoverField={() => setCoverFieldName('')}
          rowHeightKey={rowHeightKey}
          onRowHeightKeyChange={setRowHeightKey}
          frozenColumnCount={frozenColumnCount}
          onFrozenColumnCountChange={setFrozenColumnCount}
          toolbarPanel={toolbarPanel}
          onToolbarPanelChange={setToolbarPanel}
          newFieldTitle={newFieldTitle}
          newFieldType={newFieldType}
          onNewFieldTitleChange={setNewFieldTitle}
          onNewFieldTypeChange={setNewFieldType}
          onAddField={() => {
            void addField()
            setToolbarPanel(null)
          }}
          selectedRecordCount={selectedRecordIds.size}
          onRemoveSelectedRecords={() => void removeSelectedRecords()}
          onDuplicateSelectedRecords={() => void duplicateSelectedRecords()}
          agentOpen={agentOpen}
          onToggleAgent={() => setAgentOpen((open) => !open)}
          agentDisabled={!document || !activeTable}
          query={query}
          onQueryChange={setQuery}
          onAddRecord={() => void addRecord()}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={() => void undo()}
          onRedo={() => void redo()}
        />

        <TableEditorContent
          documentId={document.id}
          tableId={activeTable.id}
          viewId={activeView.id}
          viewMode={viewMode}
          fields={fields}
          visibleFields={visibleFields}
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
          onColumnFreeze={setFrozenColumnCount}
          draggingRecordId={kanbanDraggingRecordId}
          dragOverRecordId={kanbanDragOverRecordId}
          dragOverGroup={kanbanDragOverGroup}
          onDragStart={setKanbanDraggingRecordId}
          onDragEnd={clearKanbanDrag}
          onDragOverRecord={setKanbanDragOverRecordId}
          onDragOverGroup={setKanbanDragOverGroup}
          onMoveKanbanRecord={(recordId, group, targetRecordId) =>
            void moveKanbanRecord(recordId, group, targetRecordId)
          }
          onAddRecord={(initialValues) => void addRecord(initialValues)}
          onOpenRecord={setSelectedRecord}
          onOpenDocument={onOpenDocument}
          onPreviewAttachments={openAttachmentPreview}
          onSubmitForm={handleFormSubmit}
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
          onReorderField={(field, fromIndex, dropIndex) => {
            void reorderField(field, fromIndex, dropIndex, visibleFields)
          }}
          onReorderRecords={(sourceRecordId, targetRecordId, position) =>
            void reorderRecords(sourceRecordId, targetRecordId, position)
          }
          onRegenerate={(record, field) => void runAIField(record, field)}
          onUpdateCell={(record, field, value) =>
            void updateCellWithHistory(record, field, value)
          }
          onClearCells={(cells) => void clearCells(cells)}
          onPaste={(event) => void pasteRecords(event)}
          onOpenFieldCreator={() => void addDefaultField()}
          onUndo={() => void undo()}
          onRedo={() => void redo()}
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
          onClose={closeRecordContextMenu}
          onInsertRecords={(record, count, position) =>
            insertRecordsNear(record, count, position)
          }
          onDuplicateRecord={duplicateRecord}
          onCopyRecordURL={copyRecordURL}
          onOpenRecord={setSelectedRecord}
          onCopyRecordForChat={copyRecordValuesForChat}
          onDeleteRecord={removeRecord}
          onRegenerateAIField={(record, field) => void runAIField(record, field)}
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
          onEditField={setEditingField}
          onDuplicateField={columnActions.duplicateField}
          onRunAIBatch={handleColumnAIBatch}
          onDownloadAllFiles={columnActions.downloadAllFiles}
          onAddColumnToChat={columnActions.copyColumnValuesForChat}
          onInsertField={columnActions.insertField}
          onAddFilterForField={columnActions.addFilterForField}
          onAddSortForField={columnActions.addSortForField}
          onSetGroupField={columnActions.setGroupField}
          onFreezeUpTo={columnActions.freezeUpToField}
          onHideField={columnActions.hideField}
          onDeleteField={removeField}
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
          onSave={(updates) => saveField(editingField, updates)}
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
            fields={fields}
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
            onDelete={() => {
              void removeRecord(selectedRecord.id)
              setSelectedRecord(null)
            }}
            onUpdate={(field, value) =>
              void updateCellWithHistory(selectedRecord, field, value)
            }
            onReplaceLinks={async (field: DataField, rowKeys: string[]): Promise<LinkRef[] | null> => {
              try {
                const refs = await replaceRecordLinks(document.id, activeTable.id, selectedRecord.id, field.id, rowKeys)
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
            }}
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
