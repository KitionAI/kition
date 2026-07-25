import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { updateDataView } from '@/api/dataDocuments'
import type { DataDocument, DataTable, DataView } from '@/types/dataDocument'
import { parseFilterTree } from '@/features/table/filter'
import {
  readViewConfig,
  type DataInlineFilterGroup,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type DataInlineViewConfig,
  type DataInlineViewMode,
  type GridRowHeightKey,
  type SortDirection,
} from '@/features/table/lib/tableEditorShared'

type UseTableViewStateArgs = {
  document: DataDocument | null
  activeTable: DataTable | null
  activeView: DataView | null
  tableViews: DataView[]
  setDocument: Dispatch<SetStateAction<DataDocument | null>>
  setActiveViewId: Dispatch<SetStateAction<number | null>>
}

export function useTableViewState({
  document,
  activeTable,
  activeView,
  tableViews,
  setDocument,
  setActiveViewId,
}: UseTableViewStateArgs) {
  const [hiddenFieldNames, setHiddenFieldNames] = useState<Set<string>>(new Set())
  const [sortFieldName, setSortFieldName] = useState('')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [sortItems, setSortItems] = useState<DataInlineSortItem[]>([])
  const [groupFieldName, setGroupFieldName] = useState('')
  const [groupItems, setGroupItems] = useState<DataInlineGroupItem[]>([])
  const [coverFieldName, setCoverFieldName] = useState('')
  const [filterFieldName, setFilterFieldName] = useState('')
  const [filterOperator, setFilterOperator] = useState<string>('contains')
  const [filterValue, setFilterValue] = useState('')
  const [filterTree, setFilterTree] = useState<DataInlineFilterGroup | null>(null)
  const [rowHeightKey, setRowHeightKey] = useState<GridRowHeightKey>('medium')
  const [frozenColumnCount, setFrozenColumnCount] = useState(1)
  const skipNextViewConfigPersistRef = useRef<number | null>(null)

  const viewMode: DataInlineViewMode = activeView?.type || 'grid'

  useEffect(() => {
    setActiveViewId((current) => current && tableViews.some((view) => view.id === current) ? current : tableViews[0]?.id ?? null)
  }, [activeTable?.id, setActiveViewId, tableViews])

  useEffect(() => {
    if (activeView) skipNextViewConfigPersistRef.current = activeView.id
    const config = readViewConfig(activeView)
    setHiddenFieldNames(new Set(config.hidden_field_names || []))
    setFilterFieldName(config.filter?.field_name || '')
    setFilterOperator(config.filter?.operator || 'contains')
    setFilterValue(config.filter?.value || '')
    setFilterTree(parseFilterTree(config.filter_tree))
    setSortFieldName(config.sort?.field_name || '')
    setSortDirection(config.sort?.direction || 'asc')
    setSortItems(Array.isArray(config.sort_items) ? config.sort_items : [])
    setGroupFieldName(config.group_field_name || '')
    setGroupItems(Array.isArray(config.group_items) ? config.group_items : [])
    setCoverFieldName(config.cover_field_name || '')
    setRowHeightKey(config.row_height || 'medium')
    setFrozenColumnCount(typeof config.frozen_column_count === 'number' ? config.frozen_column_count : 1)
  }, [activeTable?.id, activeView?.id])

  useEffect(() => {
    if (!document || !activeTable || !activeView) return
    if (skipNextViewConfigPersistRef.current === activeView.id) {
      skipNextViewConfigPersistRef.current = null
      return
    }
    const documentId = document.id
    const tableId = activeTable.id
    const viewId = activeView.id
    const timer = window.setTimeout(() => {
      const config: DataInlineViewConfig = {
        hidden_field_names: Array.from(hiddenFieldNames),
        filter: filterFieldName ? { field_name: filterFieldName, operator: filterOperator, value: filterValue } : undefined,
        filter_tree: filterTree && filterTree.children.length > 0 ? filterTree : undefined,
        sort: sortFieldName ? { field_name: sortFieldName, direction: sortDirection } : undefined,
        sort_items: sortItems.length ? sortItems : undefined,
        group_field_name: groupFieldName || undefined,
        group_items: groupItems.length ? groupItems : undefined,
        cover_field_name: coverFieldName || undefined,
        row_height: rowHeightKey,
        frozen_column_count: frozenColumnCount,
      }
      void updateDataView(documentId, tableId, viewId, { config }).then((updated) => {
        setDocument((current) => current ? {
          ...current,
          tables: current.tables?.map((table) => table.id === tableId ? {
            ...table,
            views: table.views?.map((view) => view.id === updated.id ? updated : view),
          } : table),
        } : current)
      }).catch(() => {
        // View state remains usable locally; persistence will retry on the next change.
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    activeTable?.id,
    activeView?.id,
    coverFieldName,
    document?.id,
    filterFieldName,
    filterOperator,
    filterTree,
    filterValue,
    frozenColumnCount,
    groupFieldName,
    groupItems,
    hiddenFieldNames,
    rowHeightKey,
    setDocument,
    sortDirection,
    sortFieldName,
    sortItems,
  ])

  return {
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
  }
}
