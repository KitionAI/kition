import type { DataField, DataRecord } from '@/types/dataDocument'
import type { CombinedSelection } from '@/features/table/grid'
import { formatTableFieldValue } from '@/features/table/lib/dateFormatting'

function expandRanges(ranges: Array<[number, number]>, limit: number) {
  const indices = new Set<number>()
  for (const [start, end] of ranges) {
    const lower = Math.max(0, Math.min(start, end))
    const upper = Math.min(limit - 1, Math.max(start, end))
    for (let index = lower; index <= upper; index++) indices.add(index)
  }
  return [...indices].sort((left, right) => left - right)
}

function encodeTsvCell(field: DataField, value: unknown) {
  const text = formatTableFieldValue(field, value).replace(/\r\n?/g, '\n')
  if (!/[\t\n"]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

export function serializeTableSelection(
  selection: CombinedSelection,
  fields: DataField[],
  records: DataRecord[],
) {
  if (!fields.length || !records.length || selection.isNoneSelection) return ''

  let rowIndices: number[] = []
  let columnIndices: number[] = []

  if (selection.isCellSelection) {
    const [start, end] = selection.serialize()
    if (!start || !end) return ''
    columnIndices = expandRanges([[start[0], end[0]]], fields.length)
    rowIndices = expandRanges([[start[1], end[1]]], records.length)
  } else if (selection.isRowSelection) {
    rowIndices = expandRanges(selection.serialize() as Array<[number, number]>, records.length)
    columnIndices = fields.map((_, index) => index)
  } else if (selection.isColumnSelection) {
    columnIndices = expandRanges(selection.serialize() as Array<[number, number]>, fields.length)
    rowIndices = records.map((_, index) => index)
  }

  if (!rowIndices.length || !columnIndices.length) return ''

  return rowIndices
    .map((rowIndex) => {
      const record = records[rowIndex]
      return columnIndices
        .map((columnIndex) => {
          const field = fields[columnIndex]
          return encodeTsvCell(field, record.values?.[field.name] ?? null)
        })
        .join('\t')
    })
    .join('\n')
}
