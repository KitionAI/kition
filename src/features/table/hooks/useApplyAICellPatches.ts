import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { DataField, DataRecord, DataRecordValue } from '@/types/dataDocument'

/**
 * One streaming AI cell-fill instruction. `recordId` and `fieldId` are
 * the int64 ids the scenario orchestrator emits in `cell.ai.filled`
 * SSE events. `value` is the AI extraction output — anything the
 * column type can store (string, number, date, object, null), or a
 * `DataAttachment[]` for image-generation AI fields.
 */
export interface AICellPatch {
  recordId: number
  fieldId: number
  value: DataRecordValue
}

/**
 * Merge streaming `cell.ai.filled` events into the local `records`
 * state so the user sees the cell flip from the AI placeholder to the
 * extracted value without a refetch.
 *
 * The caller passes an append-only `patches` array; we keep a
 * highwater mark in a ref so re-renders, prop replacement with the
 * same logical contents, and React StrictMode double-effects do not
 * apply the same patch twice. Each new entry past the highwater mark
 * is translated from `fieldId` → `field.name` (via `fields`) and
 * merged into the matching record's `values` object. Records or
 * fields we don't recognise locally are silently skipped — the
 * orchestrator may race ahead of the table fetch on slow clients,
 * and a subsequent loadRecords() will fill in the value once the
 * row exists.
 *
 * `setRecords` accepts a functional updater so we coalesce multiple
 * patches into a single state mutation per effect run.
 *
 * Errors thrown by the updater (defensive: should never happen with
 * the immutable spread we use) are caught and logged so a single bad
 * frame cannot crash the scenario build page.
 */
export function useApplyAICellPatches({
  patches,
  fields,
  setRecords,
}: {
  patches?: ReadonlyArray<AICellPatch>
  fields: DataField[]
  setRecords: Dispatch<SetStateAction<DataRecord[]>>
}) {
  const appliedRef = useRef(0)

  useEffect(() => {
    if (!patches || patches.length === 0) {
      // Reset the highwater mark whenever the caller hands us a fresh
      // (possibly empty) list — e.g. after a reset back to the start
      // page that drops all events. Without this, a second build run
      // in the same session would silently skip the new patches.
      appliedRef.current = 0
      return
    }
    if (patches.length <= appliedRef.current) return
    if (fields.length === 0) {
      // Fields haven't loaded yet — defer until we can translate
      // fieldId → field.name. The effect will re-run once `fields`
      // changes (we depend on its length below).
      return
    }

    const fieldNameById = new Map<number, string>()
    for (const field of fields) {
      fieldNameById.set(field.id, field.name)
    }

    const fresh = patches.slice(appliedRef.current)
    appliedRef.current = patches.length

    try {
      setRecords((items) => {
        let mutated = false
        const next = items.map((record) => {
          let merged: DataRecord | null = null
          for (const patch of fresh) {
            if (patch.recordId !== record.id) continue
            const name = fieldNameById.get(patch.fieldId)
            if (!name) continue
            const current = merged ?? record
            merged = {
              ...current,
              values: { ...(current.values ?? {}), [name]: patch.value },
            }
          }
          if (merged) {
            mutated = true
            return merged
          }
          return record
        })
        return mutated ? next : items
      })
    } catch (error) {
      // Don't let a malformed patch tear down the scenario build page.
      // eslint-disable-next-line no-console
      console.warn('[useApplyAICellPatches] failed to apply patches', error)
    }
  }, [patches, fields, setRecords])
}
