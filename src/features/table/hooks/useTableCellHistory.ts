import { useCallback, useEffect, useRef, useState } from 'react'
import isEqual from 'lodash-es/isEqual'

import type { DataField, DataRecord, DataRecordValue } from '@/types/dataDocument'
import { coerceValue } from '@/features/table/lib/tableEditorShared'

type CellHistoryEntry = {
  id: number
  recordId: number
  fieldName: string
  before: DataRecordValue
  after: DataRecordValue
}

type UpdateCell = (
  record: DataRecord,
  field: DataField,
  value: DataRecordValue,
) => Promise<boolean>

const MAX_HISTORY_ENTRIES = 100

function cloneValue(value: DataRecordValue | undefined): DataRecordValue {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as DataRecordValue
}

export function useTableCellHistory({
  fields,
  records,
  resetKey,
  updateCell,
}: {
  fields: DataField[]
  records: DataRecord[]
  resetKey: string
  updateCell: UpdateCell
}) {
  const fieldsRef = useRef(fields)
  const recordsRef = useRef(records)
  const updateCellRef = useRef(updateCell)
  fieldsRef.current = fields
  recordsRef.current = records
  updateCellRef.current = updateCell

  const undoStackRef = useRef<CellHistoryEntry[]>([])
  const redoStackRef = useRef<CellHistoryEntry[]>([])
  const pendingRef = useRef(new Set<Promise<boolean>>())
  const busyRef = useRef(false)
  const nextIdRef = useRef(1)
  const [, setVersion] = useState(0)

  const refresh = useCallback(() => setVersion((version) => version + 1), [])

  useEffect(() => {
    undoStackRef.current = []
    redoStackRef.current = []
    pendingRef.current.clear()
    busyRef.current = false
    refresh()
  }, [resetKey, refresh])

  const waitForPending = useCallback(async () => {
    while (pendingRef.current.size > 0) {
      await Promise.allSettled(Array.from(pendingRef.current))
    }
  }, [])

  const updateCellWithHistory = useCallback(
    async (record: DataRecord, field: DataField, rawValue: DataRecordValue) => {
      const before = cloneValue(record.values?.[field.name])
      const after = cloneValue(coerceValue(field, rawValue))
      if (isEqual(before, after)) return true

      const entry: CellHistoryEntry = {
        id: nextIdRef.current++,
        recordId: record.id,
        fieldName: field.name,
        before,
        after,
      }
      undoStackRef.current = [
        ...undoStackRef.current.slice(-(MAX_HISTORY_ENTRIES - 1)),
        entry,
      ]
      redoStackRef.current = []
      refresh()

      const request = updateCellRef.current(record, field, after).then((saved) => {
        if (!saved) {
          undoStackRef.current = undoStackRef.current.filter((item) => item.id !== entry.id)
          redoStackRef.current = redoStackRef.current.filter((item) => item.id !== entry.id)
          refresh()
        }
        return saved
      }).finally(() => {
        pendingRef.current.delete(request)
      })
      pendingRef.current.add(request)
      return request
    },
    [refresh],
  )

  const applyHistoryEntry = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (busyRef.current) return false
      busyRef.current = true
      refresh()
      try {
        await waitForPending()
        const source = direction === 'undo' ? undoStackRef.current : redoStackRef.current
        const entry = source.at(-1)
        if (!entry) return false

        const record = recordsRef.current.find((item) => item.id === entry.recordId)
        const field = fieldsRef.current.find((item) => item.name === entry.fieldName)
        if (!record || !field) {
          source.pop()
          return false
        }

        source.pop()
        refresh()
        const value = direction === 'undo' ? entry.before : entry.after
        const saved = await updateCellRef.current(record, field, cloneValue(value))
        if (saved) {
          const target = direction === 'undo' ? redoStackRef.current : undoStackRef.current
          target.push(entry)
        } else {
          source.push(entry)
        }
        return saved
      } finally {
        busyRef.current = false
        refresh()
      }
    },
    [refresh, waitForPending],
  )

  const undo = useCallback(() => applyHistoryEntry('undo'), [applyHistoryEntry])
  const redo = useCallback(() => applyHistoryEntry('redo'), [applyHistoryEntry])

  return {
    canUndo: undoStackRef.current.length > 0,
    canRedo: redoStackRef.current.length > 0,
    historyBusy: busyRef.current,
    updateCellWithHistory,
    undo,
    redo,
  }
}
