import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTableDataSource } from '../ports/TableDataSource'
import type { DataDocument, DataTable, DataView } from '../../types/dataDocument'
import { parseFilterTree } from '../filter'
import {
  readViewConfig,
  type DataInlineFilterGroup,
  type DataInlineGroupItem,
  type DataInlineSortItem,
  type DataInlineViewConfig,
  type DataInlineViewMode,
  type GridRowHeightKey,
  type SortDirection,
} from '../lib/tableEditorShared'

/** The view settings the editor holds as state, and persists as the view's config. */
export type TableViewSettings = {
  hiddenFieldNames: ReadonlySet<string>
  filterFieldName: string
  filterOperator: string
  filterValue: string
  filterTree: DataInlineFilterGroup | null
  sortFieldName: string
  sortDirection: SortDirection
  sortItems: DataInlineSortItem[]
  groupFieldName: string
  groupItems: DataInlineGroupItem[]
  coverFieldName: string
  rowHeightKey: GridRowHeightKey
  frozenColumnCount: number
}

/** The settings a view's stored config gives, with the editor's defaults for what it leaves out. */
export function viewSettingsOf(view: DataView | null | undefined): TableViewSettings {
  const config = readViewConfig(view)
  return {
    hiddenFieldNames: new Set(config.hidden_field_names || []),
    filterFieldName: config.filter?.field_name || '',
    filterOperator: config.filter?.operator || 'contains',
    filterValue: config.filter?.value || '',
    filterTree: parseFilterTree(config.filter_tree),
    sortFieldName: config.sort?.field_name || '',
    sortDirection: config.sort?.direction || 'asc',
    sortItems: Array.isArray(config.sort_items) ? config.sort_items : [],
    groupFieldName: config.group_field_name || '',
    groupItems: Array.isArray(config.group_items) ? config.group_items : [],
    coverFieldName: config.cover_field_name || '',
    rowHeightKey: config.row_height || 'medium',
    frozenColumnCount: typeof config.frozen_column_count === 'number' ? config.frozen_column_count : 1,
  }
}

/** The config the editor persists for `settings`. */
export function viewConfigOf(settings: TableViewSettings): DataInlineViewConfig {
  return {
    hidden_field_names: Array.from(settings.hiddenFieldNames),
    filter: settings.filterFieldName ? { field_name: settings.filterFieldName, operator: settings.filterOperator, value: settings.filterValue } : undefined,
    filter_tree: settings.filterTree && settings.filterTree.children.length > 0 ? settings.filterTree : undefined,
    sort: settings.sortFieldName ? { field_name: settings.sortFieldName, direction: settings.sortDirection } : undefined,
    sort_items: settings.sortItems.length ? settings.sortItems : undefined,
    group_field_name: settings.groupFieldName || undefined,
    group_items: settings.groupItems.length ? settings.groupItems : undefined,
    cover_field_name: settings.coverFieldName || undefined,
    row_height: settings.rowHeightKey,
    frozen_column_count: settings.frozenColumnCount,
  }
}

/**
 * Whether `config` says what `view` already holds. Opening a view only reads it: its settings
 * pass through state (as new objects) and come back as a config that differs from the stored one
 * only in the defaults it spells out, which is no change to write. Writing it would make a
 * document that was only opened unsaved, and add an undo step nobody took.
 */
export function viewConfigUnchanged(view: DataView, config: DataInlineViewConfig): boolean {
  return JSON.stringify(viewConfigOf(viewSettingsOf(view))) === JSON.stringify(config)
}

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
  const dataSource = useTableDataSource()
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
    const settings = viewSettingsOf(activeView)
    setHiddenFieldNames(new Set(settings.hiddenFieldNames))
    setFilterFieldName(settings.filterFieldName)
    setFilterOperator(settings.filterOperator)
    setFilterValue(settings.filterValue)
    setFilterTree(settings.filterTree)
    setSortFieldName(settings.sortFieldName)
    setSortDirection(settings.sortDirection)
    setSortItems(settings.sortItems)
    setGroupFieldName(settings.groupFieldName)
    setGroupItems(settings.groupItems)
    setCoverFieldName(settings.coverFieldName)
    setRowHeightKey(settings.rowHeightKey)
    setFrozenColumnCount(settings.frozenColumnCount)
    // Depends on the `activeView` object itself, not just its id: a live
    // `table/changed` event (another window editing the same view) or an
    // undo/redo replaces the document with a freshly fetched `activeView`
    // that keeps the same id but carries a different `config`, and the
    // local view state below needs to pick that up.
  }, [activeTable?.id, activeView])

  useEffect(() => {
    if (!document || !activeTable || !activeView) return
    if (skipNextViewConfigPersistRef.current === activeView.id) {
      skipNextViewConfigPersistRef.current = null
      return
    }
    const config = viewConfigOf({
      hiddenFieldNames,
      filterFieldName,
      filterOperator,
      filterValue,
      filterTree,
      sortFieldName,
      sortDirection,
      sortItems,
      groupFieldName,
      groupItems,
      coverFieldName,
      rowHeightKey,
      frozenColumnCount,
    })
    if (viewConfigUnchanged(activeView, config)) return
    const documentId = document.id
    const tableId = activeTable.id
    const viewId = activeView.id
    const timer = window.setTimeout(() => {
      void dataSource.views.update({ documentId, tableId, viewId, config }).then((updated) => {
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
    activeView,
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
