import type { DataField, DataFieldType, DataView } from '@/types/dataDocument'
import {
  type DataInlineFilterGroup,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type DataInlineViewMode,
  type GridRowHeightKey,
  type ToolbarPanel,
} from '@/features/table/lib/tableEditorShared'

import { TableEditorToolbarHeader } from './TableEditorToolbarHeader'
import { TableEditorToolbarPropertyBar } from './TableEditorToolbarPropertyBar'

export function TableEditorToolbar({
  tableViews,
  activeViewId,
  onSelectView,
  viewCreateOpen,
  onToggleViewCreate,
  onCloseViewCreate,
  onCreateView,
  onRenameView,
  onDuplicateView,
  onDeleteView,
  busy,
  fields,
  hiddenFieldNames,
  onResetHiddenFields,
  onToggleFieldVisibility,
  onEditField,
  onDuplicateField,
  onDeleteField,
  onAddDefaultField,
  filterTree,
  onFilterTreeChange,
  sortItems,
  onSortItemsChange,
  groupableFields,
  groupItems,
  onGroupItemsChange,
  viewMode,
  coverFieldName,
  coverField,
  coverFields,
  onCoverFieldNameChange,
  onResetCoverField,
  rowHeightKey,
  onRowHeightKeyChange,
  frozenColumnCount,
  onFrozenColumnCountChange,
  toolbarPanel,
  onToolbarPanelChange,
  newFieldTitle,
  newFieldType,
  onNewFieldTitleChange,
  onNewFieldTypeChange,
  onAddField,
  selectedRecordCount,
  onRemoveSelectedRecords,
  onDuplicateSelectedRecords,
  agentOpen,
  onToggleAgent,
  agentDisabled,
  query,
  onQueryChange,
  onAddRecord,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tableViews: DataView[]
  activeViewId: number | null
  onSelectView: (viewId: number) => void
  viewCreateOpen: boolean
  onToggleViewCreate: () => void
  onCloseViewCreate: () => void
  onCreateView: (type: DataInlineViewMode) => void
  onRenameView: (viewId: number, nextTitle: string) => void
  onDuplicateView: (viewId: number) => void
  onDeleteView: (viewId: number) => void
  busy: boolean
  fields: DataField[]
  hiddenFieldNames: Set<string>
  onResetHiddenFields: () => void
  onToggleFieldVisibility: (fieldName: string, checked: boolean) => void
  onEditField: (field: DataField) => void
  onDuplicateField: (field: DataField) => void
  onDeleteField: (field: DataField) => void
  onAddDefaultField: () => void
  filterTree: DataInlineFilterGroup | null
  onFilterTreeChange: (next: DataInlineFilterGroup | null) => void
  sortItems: DataInlineSortItem[]
  onSortItemsChange: (items: DataInlineSortItem[]) => void
  groupableFields: DataField[]
  groupItems: DataInlineGroupItem[]
  onGroupItemsChange: (items: DataInlineGroupItem[]) => void
  viewMode: DataInlineViewMode
  coverFieldName: string
  coverField: DataField | null
  coverFields: DataField[]
  onCoverFieldNameChange: (value: string) => void
  onResetCoverField: () => void
  rowHeightKey: GridRowHeightKey
  onRowHeightKeyChange: (value: GridRowHeightKey) => void
  frozenColumnCount: number
  onFrozenColumnCountChange: (count: number) => void
  toolbarPanel: ToolbarPanel
  onToolbarPanelChange: (panel: ToolbarPanel) => void
  newFieldTitle: string
  newFieldType: DataFieldType
  onNewFieldTitleChange: (value: string) => void
  onNewFieldTypeChange: (value: DataFieldType) => void
  onAddField: () => void
  selectedRecordCount: number
  onRemoveSelectedRecords: () => void
  onDuplicateSelectedRecords: () => void
  agentOpen: boolean
  onToggleAgent: () => void
  agentDisabled: boolean
  query: string
  onQueryChange: (value: string) => void
  onAddRecord: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}) {
  return (
    <>
      <TableEditorToolbarHeader
        tableViews={tableViews}
        activeViewId={activeViewId}
        onSelectView={onSelectView}
        viewCreateOpen={viewCreateOpen}
        onToggleViewCreate={onToggleViewCreate}
        onCloseViewCreate={onCloseViewCreate}
        onCreateView={onCreateView}
        onRenameView={onRenameView}
        onDuplicateView={onDuplicateView}
        onDeleteView={onDeleteView}
        busy={busy}
      />
      <TableEditorToolbarPropertyBar
        busy={busy}
        fields={fields}
        hiddenFieldNames={hiddenFieldNames}
        onResetHiddenFields={onResetHiddenFields}
        onToggleFieldVisibility={onToggleFieldVisibility}
        onEditField={onEditField}
        onDuplicateField={onDuplicateField}
        onDeleteField={onDeleteField}
        onAddDefaultField={onAddDefaultField}
        filterTree={filterTree}
        onFilterTreeChange={onFilterTreeChange}
        sortItems={sortItems}
        onSortItemsChange={onSortItemsChange}
        groupableFields={groupableFields}
        groupItems={groupItems}
        onGroupItemsChange={onGroupItemsChange}
        viewMode={viewMode}
        coverFieldName={coverFieldName}
        coverField={coverField}
        coverFields={coverFields}
        onCoverFieldNameChange={onCoverFieldNameChange}
        onResetCoverField={onResetCoverField}
        rowHeightKey={rowHeightKey}
        onRowHeightKeyChange={onRowHeightKeyChange}
        frozenColumnCount={frozenColumnCount}
        onFrozenColumnCountChange={onFrozenColumnCountChange}
        toolbarPanel={toolbarPanel}
        onToolbarPanelChange={onToolbarPanelChange}
        newFieldTitle={newFieldTitle}
        newFieldType={newFieldType}
        onNewFieldTitleChange={onNewFieldTitleChange}
        onNewFieldTypeChange={onNewFieldTypeChange}
        onAddField={onAddField}
        selectedRecordCount={selectedRecordCount}
        onRemoveSelectedRecords={onRemoveSelectedRecords}
        onDuplicateSelectedRecords={onDuplicateSelectedRecords}
        agentOpen={agentOpen}
        onToggleAgent={onToggleAgent}
        agentDisabled={agentDisabled}
        query={query}
        onQueryChange={onQueryChange}
        onAddRecord={onAddRecord}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
      />
    </>
  )
}
