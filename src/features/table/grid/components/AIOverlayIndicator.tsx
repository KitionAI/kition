import { RefreshCcw } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { aiCellStore, type CellKey } from '@/features/table/store/aiCellGenerationStore'
import type { ICellItem, IScrollState } from '../interface'
import type { CoordinateManager } from '../managers'

export interface IAIOverlayCell {
  cellItem: ICellItem
  cellKey: CellKey
}

export interface IAIOverlayIndicatorProps {
  cells: IAIOverlayCell[]
  coordInstance: CoordinateManager
  scrollState: IScrollState
  real2RowIndex: (index: number) => number
  onAction: (cellItem: ICellItem) => void
}

function useStoreVersion() {
  return useSyncExternalStore(
    (listener) => aiCellStore.subscribeAll(listener),
    () => aiCellStore.getVersion(),
    () => 0,
  )
}

export const AIOverlayIndicator = (props: IAIOverlayIndicatorProps) => {
  const { cells, coordInstance, scrollState, real2RowIndex, onAction } = props
  const { t } = useTranslation('table')
  useStoreVersion()

  if (!cells.length) return null

  const { scrollLeft, scrollTop } = scrollState
  const { rowInitSize, freezeColumnCount, freezeRegionWidth, containerWidth, containerHeight } =
    coordInstance

  return (
    <div className="pointer-events-none absolute left-0 top-0">
      {cells.map(({ cellItem, cellKey }) => {
        const [columnIndex, realRowIndex] = cellItem
        if (realRowIndex >= coordInstance.pureRowCount) return null
        const rowIndex = real2RowIndex(realRowIndex)
        if (rowIndex == null) return null

        const status = aiCellStore.get(cellKey)
        const rowHeight = coordInstance.getRowHeight(rowIndex)
        const rowOffset = coordInstance.getRowOffset(rowIndex)
        const columnWidth = coordInstance.getColumnWidth(columnIndex)
        const columnOffset = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft)

        const y = rowOffset - scrollTop
        const isFreeze = columnIndex < freezeColumnCount
        const isColumnVisible =
          isFreeze ||
          (columnOffset + columnWidth - 24 >= freezeRegionWidth && columnOffset <= containerWidth)
        const isRowVisible = y >= rowInitSize - 4 && y <= containerHeight - rowInitSize + 4
        if (!isColumnVisible || !isRowVisible) return null

        const isPending = status.status === 'pending'
        return (
          <div
            key={`ai-${columnIndex}-${realRowIndex}`}
            className="absolute"
            style={{ left: columnOffset, top: y, width: columnWidth, height: rowHeight }}
          >
            {isPending ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                <div className="size-5 animate-spin rounded-full border-2 border-transparent border-t-blue-500" />
              </div>
            ) : (
                                                                            
                                                                          
                                                          
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onAction(cellItem)
                }}
                className="pointer-events-auto absolute right-1 top-1 grid size-5 place-items-center rounded bg-background/90 text-muted-foreground opacity-60 transition hover:bg-blue-500/15 hover:text-blue-500 hover:opacity-100"
                aria-label={t('aiOverlay.regenerate')}
              >
                <RefreshCcw className="size-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
