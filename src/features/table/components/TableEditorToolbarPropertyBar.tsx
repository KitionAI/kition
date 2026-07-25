import { Copy, Plus, Redo2, Search, Trash2, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DataField, DataFieldType } from '@/types/dataDocument'
import { Button } from '@/components/ui'
import {
  type DataInlineFilterGroup,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type DataInlineViewMode,
  type GridRowHeightKey,
  type ToolbarPanel,
} from '@/features/table/lib/tableEditorShared'

import { FilterPopover } from '@/features/table/filter'
import {
  TableEditorCoverControl,
  TableEditorFieldConfigControl,
  TableEditorFreezeControl,
  TableEditorMultiGroupControl,
  TableEditorMultiSortControl,
  TableEditorRowHeightControl,
} from './TableEditorToolbarControls'

export function TableEditorToolbarPropertyBar({
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
  const { t } = useTranslation('table')
  return (
    <div className="data-inline-property-bar">
      <Button
        variant="brand"
        className="data-inline-add-record-button"
        onClick={onAddRecord}
        disabled={busy}
      >
        <Plus className="size-4" />
        {t('propertyBar.addRecord')}
      </Button>
      <span className="data-inline-toolbar-divider" aria-hidden="true" />
      <TableEditorFieldConfigControl
        fields={fields}
        hiddenFieldNames={hiddenFieldNames}
        open={toolbarPanel === 'hidden'}
        onOpenChange={(open) => onToolbarPanelChange(open ? 'hidden' : null)}
        onResetHiddenFields={onResetHiddenFields}
        onToggleFieldVisibility={onToggleFieldVisibility}
        busy={busy}
        onEditField={onEditField}
        onDuplicateField={onDuplicateField}
        onDeleteField={onDeleteField}
        onOpenAddField={onAddDefaultField}
      />
      <FilterPopover
        open={toolbarPanel === 'filter'}
        onOpenChange={(o) => onToolbarPanelChange(o ? 'filter' : null)}
        fields={fields}
        value={filterTree}
        onChange={onFilterTreeChange}
      />
      <TableEditorMultiSortControl
        fields={fields}
        sortItems={sortItems}
        open={toolbarPanel === 'sort'}
        onOpenChange={(open) => onToolbarPanelChange(open ? 'sort' : null)}
        onSortItemsChange={onSortItemsChange}
      />
      <TableEditorMultiGroupControl
        groupableFields={groupableFields}
        groupItems={groupItems}
        open={toolbarPanel === 'group'}
        onOpenChange={(open) => onToolbarPanelChange(open ? 'group' : null)}
        onGroupItemsChange={onGroupItemsChange}
      />

      {viewMode === 'gallery' ? (
        <TableEditorCoverControl
          coverField={coverField}
          coverFieldName={coverFieldName}
          coverFields={coverFields}
          open={toolbarPanel === 'cover'}
          onOpenChange={(open) => onToolbarPanelChange(open ? 'cover' : null)}
          onCoverFieldNameChange={onCoverFieldNameChange}
          onResetCoverField={onResetCoverField}
        />
      ) : null}

      {viewMode === 'grid' ? (
        <>
          <TableEditorRowHeightControl
            rowHeightKey={rowHeightKey}
            open={toolbarPanel === 'rowHeight'}
            onOpenChange={(open) =>
              onToolbarPanelChange(open ? 'rowHeight' : null)
            }
            onRowHeightKeyChange={onRowHeightKeyChange}
          />
          <TableEditorFreezeControl
            fields={fields}
            frozenColumnCount={frozenColumnCount}
            open={toolbarPanel === 'freeze'}
            onOpenChange={(open) =>
              onToolbarPanelChange(open ? 'freeze' : null)
            }
            onFrozenColumnCountChange={onFrozenColumnCountChange}
          />
        </>
      ) : null}

      {selectedRecordCount ? (
        <>
          <span className="data-inline-property-divider" />
          <Button
            variant="outline"
            className="data-inline-add-record-button"
            onClick={onDuplicateSelectedRecords}
            disabled={busy}
          >
            <Copy className="size-4" />
            {t('propertyBar.duplicateCount', { count: selectedRecordCount })}
          </Button>
          <Button
            variant="outline"
            className="data-inline-danger-button"
            onClick={onRemoveSelectedRecords}
            disabled={busy}
          >
            <Trash2 className="size-4" />
            {t('propertyBar.deleteCount', { count: selectedRecordCount })}
          </Button>
        </>
      ) : null}

      <span className="data-inline-toolbar-spacer" />
      <div className="data-inline-search">
        <Search className="size-4" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('propertyBar.searchRecords')}
          data-testid="kitable-toolbar-search"
        />
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="data-inline-icon-button"
        disabled={busy || !canUndo}
        onClick={onUndo}
        title={t('propertyBar.undo')}
        aria-label={t('propertyBar.undo')}
        data-testid="kitable-toolbar-undo"
      >
        <Undo2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="data-inline-icon-button"
        disabled={busy || !canRedo}
        onClick={onRedo}
        title={t('propertyBar.redo')}
        aria-label={t('propertyBar.redo')}
        data-testid="kitable-toolbar-redo"
      >
        <Redo2 className="size-4" />
      </Button>
    </div>
  )
}
