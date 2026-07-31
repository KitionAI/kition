import { type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import {
  bulkCopyDataRecords,
  bulkDeleteDataRecords,
  createDataRecord,
  deleteDataRecord,
  runDataAIFieldBatch,
  runDataAIFieldCell,
  updateDataRecord,
  updateDataRecordOrder,
} from '@/api/dataDocuments'
import type {
  DataDocument,
  DataField,
  DataRecord,
  DataRecordValue,
  DataTable,
} from '@/types/dataDocument'
import { normalizeAIConfig } from '@/types/aiConfig'
import {
  coerceValue,
  displayValue,
  emptyRecordValues,
  kanbanGroupToValue,
  reorderById,
  reorderByIdAtPosition,
  resolveAIConfigRuntimeModel,
  type DataRecordWindow,
  type RecordContextMenuState,
  type RowDropPosition,
} from '@/features/table/lib/tableEditorShared'
import { aiCellStore, buildCellKey } from '@/features/table/store/aiCellGenerationStore'
import {
  canRunAutoAIField,
  getAutoUpdateAIFieldPlan,
  getCreateTimeAIFieldPlan,
} from '@/features/table/lib/aiFieldDependencies'
import {
  hasAIFieldPromptPlaceholders,
  materializeAIFieldPrompt,
} from '@/features/table/lib/aiPromptInterpolation'

                                                                               
                                                                 
const NON_CLEARABLE_FIELD_TYPES = new Set<string>([
  'auto_number',
  'created_time',
  'last_modified_time',
  'created_by',
  'last_modified_by',
  'lookup',
  'rollup',
  'formula',
  'link_to_record',
  'user',
  'button',
])

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
) {
  const queue = [...values]
  const output: Output[] = []
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, values.length || 1)) },
    async () => {
      while (queue.length) {
        const value = queue.shift() as Input
        output.push(await mapper(value))
      }
    },
  )
  await Promise.all(workers)
  return output
}

function isClearableField(field: DataField) {
  if (field.readonly) return false
  return !NON_CLEARABLE_FIELD_TYPES.has(field.type)
}

type UseTableRecordActionsArgs = {
  document: DataDocument | null
  activeTable: DataTable | null
  fields: DataField[]
  records: DataRecord[]
  groupField: DataField | null
  canReorderRows: boolean
  canMoveKanbanCards: boolean
  selectedRecordIds: Set<number>
  setBusy: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setRecords: Dispatch<SetStateAction<DataRecord[]>>
  setSelectedRecord: Dispatch<SetStateAction<DataRecord | null>>
  setSelectedRecordIds: Dispatch<SetStateAction<Set<number>>>
  setRecordContextMenu: Dispatch<SetStateAction<RecordContextMenuState>>
  loadRecords: (window?: DataRecordWindow) => Promise<void>
  setStatus: (message: string) => void
  copyTextToClipboard: (text: string, successMessage: string) => Promise<void>
}

export function useTableRecordActions({
  document,
  activeTable,
  fields,
  records,
  groupField,
  canReorderRows,
  canMoveKanbanCards,
  selectedRecordIds,
  setBusy,
  setError,
  setRecords,
  setSelectedRecord,
  setSelectedRecordIds,
  setRecordContextMenu,
  loadRecords,
  setStatus,
  copyTextToClipboard,
}: UseTableRecordActionsArgs) {
  const { t } = useTranslation('table')
  async function createRecordFromValues(
    values: Record<string, DataRecordValue>,
  ) {
    if (!document || !activeTable) return null
    const record = await createDataRecord(document.id, activeTable.id, {
      ...emptyRecordValues(fields),
      ...values,
    })
    setRecords((items) => [...items, record])
    window.dispatchEvent(new CustomEvent('kition:data-document:record:upsert', {
      detail: { vaultPath: document.path, tableId: activeTable.id, recordIds: [record.id] },
    }))
    // Fill auto-update AI columns for the new row in the background so the
    // row shows immediately and cells populate as each extraction lands
    // (matching the auto-fill behavior on cell edits).
    void runCreateTimeAIFields(record)
    return record
  }

  // runCreateTimeAIFields fires the enabled + auto_update AI columns whose
  // source data is already present on a freshly created record. Blank rows
  // (addRecord with no values) leave every source empty, so nothing fires.
  async function runCreateTimeAIFields(record: DataRecord) {
    if (!document || !activeTable) return
    const plan = getCreateTimeAIFieldPlan(fields)
    if (plan.cyclicFieldIds.length) {
      setError('AI field dependency cycle detected')
      return
    }
    let currentRecord = record
    for (const field of plan.fields) {
      if (!canRunAutoAIField(currentRecord, field, fields)) continue
      const updatedRecord = await executeAIField(currentRecord, field)
      if (updatedRecord) currentRecord = updatedRecord
    }
  }

  async function addRecord(
    initialValues: Record<string, DataRecordValue> = {},
  ) {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      await createRecordFromValues(initialValues)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Failed to create record',
      )
    } finally {
      setBusy(false)
    }
  }

  async function createRecordsNear(
    anchorRecord: DataRecord,
    count: number,
    position: RowDropPosition,
    valuesForRecord: () => Record<string, DataRecordValue>,
    successMessage: string,
  ) {
    if (!document || !activeTable) return
    const safeCount = Math.max(1, Math.min(50, Math.floor(count) || 1))
    setBusy(true)
    try {
      const createdRecords = await Promise.all(
        Array.from({ length: safeCount }, () =>
          createDataRecord(document.id, activeTable.id, valuesForRecord()),
        ),
      )

      if (canReorderRows) {
        const anchorIndex = records.findIndex(
          (item) => item.id === anchorRecord.id,
        )
        const insertIndex =
          anchorIndex >= 0
            ? anchorIndex + (position === 'after' ? 1 : 0)
            : records.length
        const nextRecords = [
          ...records.slice(0, insertIndex),
          ...createdRecords,
          ...records.slice(insertIndex),
        ].map((record, index) => ({ ...record, order: index + 1 }))
        setRecords(nextRecords)
        await Promise.all(
          nextRecords.map((record) =>
            updateDataRecordOrder(
              document.id,
              activeTable.id,
              record.id,
              record.order,
            ),
          ),
        )
      } else {
        setRecords((items) => [...items, ...createdRecords])
      }

      setStatus(successMessage)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Record creation failed',
      )
      void loadRecords()
    } finally {
      setBusy(false)
    }
  }

  async function insertRecordsNear(
    anchorRecord: DataRecord,
    count: number,
    position: RowDropPosition,
  ) {
    await createRecordsNear(
      anchorRecord,
      count,
      position,
      () => emptyRecordValues(fields),
      count > 1 ? `${count} records inserted` : 'Record inserted',
    )
  }

  async function duplicateRecord(anchorRecord: DataRecord) {
    await createRecordsNear(
      anchorRecord,
      1,
      'after',
      () => ({ ...(anchorRecord.values || {}) }),
      'Record duplicated',
    )
  }

  async function runAutoUpdateAIFields(
    record: DataRecord,
    changedField: DataField,
  ) {
    if (!document || !activeTable) return record
    const plan = getAutoUpdateAIFieldPlan(fields, [changedField.id])
    if (plan.cyclicFieldIds.length) {
      setError('AI field dependency cycle detected')
      return record
    }
    let currentRecord = record
    for (const field of plan.fields) {
      if (!canRunAutoAIField(currentRecord, field, fields)) continue
      const updatedRecord = await executeAIField(currentRecord, field)
      if (updatedRecord) currentRecord = updatedRecord
    }
    return currentRecord
  }

  async function updateCell(
    record: DataRecord,
    field: DataField,
    raw: DataRecordValue,
  ) {
    if (!document || !activeTable || field.readonly) return false
    const nextValue = coerceValue(field, raw)
    const updatedRecord = {
      ...record,
      values: { ...record.values, [field.name]: nextValue },
    }
    setRecords((items) =>
      items.map((item) =>
        item.id === record.id
          ? updatedRecord
          : item,
      ),
    )
    setSelectedRecord((current) =>
      current?.id === record.id
        ? updatedRecord
        : current,
    )
    try {
      await updateDataRecord(document.id, activeTable.id, record.id, {
        [field.name]: nextValue,
      })
      window.dispatchEvent(new CustomEvent('kition:data-document:record:upsert', {
        detail: { vaultPath: document.path, tableId: activeTable.id, recordIds: [record.id] },
      }))
      await runAutoUpdateAIFields(updatedRecord, field)
      return true
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Save failed',
      )
      void loadRecords()
      return false
    }
  }

  async function runAIField(record: DataRecord, field: DataField) {
    const updatedRecord = await executeAIField(record, field)
    if (!updatedRecord) return null
    return runAutoUpdateAIFields(updatedRecord, field)
  }

  async function executeAIField(record: DataRecord, field: DataField) {
    if (!document || !activeTable) return
    const config = normalizeAIConfig(field.ai_config)
    if (!config?.enabled) return
    const controller = new AbortController()
    const cellKey = buildCellKey(activeTable.id, record.id, field.id)
    aiCellStore.cancel(cellKey)
    aiCellStore.start(cellKey, config.type, controller)
    try {
      const runtimeModel = await resolveAIConfigRuntimeModel(config)
      const executionConfig = materializeAIFieldPrompt(config, record, fields)
      const result = await runDataAIFieldCell(
        document.id,
        activeTable.id,
        record.id,
        field.id,
        {
          action: executionConfig.type,
          config: executionConfig,
          force: true,
          runtime_model: runtimeModel,
        },
        { signal: controller.signal },
      )
      setRecords((items) =>
        items.map((item) => (item.id === record.id ? result.record : item)),
      )
      setSelectedRecord((current) =>
        current?.id === record.id ? result.record : current,
      )
      aiCellStore.complete(cellKey)
      setStatus(`${field.title} generated`)
      return result.record
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') {
        aiCellStore.complete(cellKey)
        return
      }
      const message = requestError instanceof Error ? requestError.message : 'AI generation failed'
      aiCellStore.fail(cellKey, message)
      setError(`${field.title}: ${message}`)
      return null
    }
  }

  async function runAIFieldBatchForRecords(
    field: DataField,
    recordIds: number[],
    scope: string,
  ) {
    if (!document || !activeTable) return
    const config = normalizeAIConfig(field.ai_config)
    if (!config?.enabled) return
    const ids = Array.from(
      new Set(recordIds.filter((recordId) => Number.isFinite(recordId) && recordId > 0)),
    ).slice(0, 100)
    if (!ids.length) {
      setError(t('feedback.selectRecordsToGenerate'))
      return
    }
    setBusy(true)
    const controller = new AbortController()
    for (const id of ids) {
      const key = buildCellKey(activeTable.id, id, field.id)
      aiCellStore.cancel(key)
      aiCellStore.start(key, config.type, controller)
    }
    setStatus(`${field.title}: generating ${ids.length} record${ids.length === 1 ? '' : 's'}…`)
    try {
      const runtimeModel = await resolveAIConfigRuntimeModel(config)
      if (hasAIFieldPromptPlaceholders(config)) {
        const generated = await mapWithConcurrency(ids, 3, async (recordId) => {
          const record = records.find((item) => item.id === recordId)
          if (!record) return { recordId, error: 'Record is not loaded' } as const
          try {
            const executionConfig = materializeAIFieldPrompt(config, record, fields)
            const result = await runDataAIFieldCell(
              document.id,
              activeTable.id,
              record.id,
              field.id,
              {
                action: executionConfig.type,
                config: executionConfig,
                force: true,
                runtime_model: runtimeModel,
              },
              { signal: controller.signal },
            )
            return { recordId, record: result.record } as const
          } catch (requestError) {
            return {
              recordId,
              error: requestError instanceof Error
                ? requestError.message
                : 'AI generation failed',
            } as const
          }
        })
        const successful = generated.flatMap((item) => ('record' in item ? [item.record] : []))
        const failures = generated.flatMap((item) => ('error' in item ? [item] : []))
        if (successful.length) {
          const updatedById = new Map(successful.map((record) => [record.id, record]))
          setRecords((items) => items.map((item) => updatedById.get(item.id) || item))
          setSelectedRecord((current) => (current ? updatedById.get(current.id) || current : current))
          for (const record of successful) {
            await runAutoUpdateAIFields(record, field)
          }
        }
        for (const id of ids) {
          const key = buildCellKey(activeTable.id, id, field.id)
          const failure = failures.find((item) => item.recordId === id)
          if (failure) aiCellStore.fail(key, failure.error)
          else aiCellStore.complete(key)
        }
        if (failures.length) {
          setError(
            `${field.title}: ${successful.length} generated, ${failures.length} failed. ${failures[0].error}`,
          )
        } else {
          setStatus(`${field.title}: ${successful.length} generated`)
        }
        return
      }
      const result = await runDataAIFieldBatch(
        document.id,
        activeTable.id,
        field.id,
        {
          action: config.type,
          config,
          record_ids: ids,
          scope,
          force: true,
          limit: 100,
          runtime_model: runtimeModel,
        },
        { signal: controller.signal },
      )
      if (result.items.length) {
        const updatedById = new Map(result.items.map((item) => [item.record.id, item.record]))
        setRecords((items) => items.map((item) => updatedById.get(item.id) || item))
        setSelectedRecord((current) => (current ? updatedById.get(current.id) || current : current))
        for (const item of result.items) {
          await runAutoUpdateAIFields(item.record, field)
        }
      }
      for (const id of ids) {
        const key = buildCellKey(activeTable.id, id, field.id)
        const failure = result.errors?.find((entry) => entry.record_id === id)
        if (failure) aiCellStore.fail(key, failure.message)
        else aiCellStore.complete(key)
      }
      if (result.failed) {
        const firstError = result.errors?.[0]?.message || 'Some records failed to generate'
        setError(`${field.title}: ${result.completed} generated, ${result.failed} failed. ${firstError}`)
      } else {
        setStatus(`${field.title}: ${result.completed} generated`)
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'AI batch generation failed'
      for (const id of ids) {
        const key = buildCellKey(activeTable.id, id, field.id)
        aiCellStore.fail(key, message)
      }
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  async function clearCells(
    cells: Array<{ record: DataRecord; field: DataField }>,
  ) {
    if (!document || !activeTable || !cells.length) return
    const docId = document.id
    const tableIdActive = activeTable.id

                                               
                                                               
                      
    const byRecord = new Map<number, { record: DataRecord; fields: DataField[] }>()
    for (const { record, field } of cells) {
      if (!isClearableField(field)) continue
      const existing = byRecord.get(record.id)
      const entry = existing ?? { record, fields: [] as DataField[] }
      if (!entry.fields.some((item) => item.id === field.id)) entry.fields.push(field)
      if (!existing) byRecord.set(record.id, entry)
    }
    if (!byRecord.size) return

    const updates: Array<{ recordId: number; values: Record<string, DataRecordValue> }> = []
    for (const { record, fields } of byRecord.values()) {
      const values: Record<string, DataRecordValue> = {}
      for (const field of fields) values[field.name] = coerceValue(field, null)
      updates.push({ recordId: record.id, values })
    }

    const patchByRecordId = new Map(updates.map((entry) => [entry.recordId, entry.values]))
    setRecords((items) =>
      items.map((item) => {
        const patch = patchByRecordId.get(item.id)
        if (!patch) return item
        return { ...item, values: { ...item.values, ...patch } }
      }),
    )
    setSelectedRecord((current) => {
      if (!current) return current
      const patch = patchByRecordId.get(current.id)
      if (!patch) return current
      return { ...current, values: { ...current.values, ...patch } }
    })

    setBusy(true)
    try {
      await Promise.all(
        updates.map((entry) =>
          updateDataRecord(docId, tableIdActive, entry.recordId, entry.values),
        ),
      )
      const cleared = updates.reduce(
        (total, entry) => total + Object.keys(entry.values).length,
        0,
      )
      setStatus(`Cleared ${cleared} cell${cleared === 1 ? '' : 's'}`)
      window.dispatchEvent(new CustomEvent('kition:data-document:record:upsert', {
        detail: { vaultPath: document.path, tableId: tableIdActive, recordIds: updates.map((u) => u.recordId) },
      }))
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Clear cells failed',
      )
      void loadRecords()
    } finally {
      setBusy(false)
    }
  }

  async function removeRecord(recordId: number) {
    if (!document || !activeTable) return
    setBusy(true)
    try {
      await deleteDataRecord(document.id, activeTable.id, recordId)
      setRecords((items) => items.filter((item) => item.id !== recordId))
      setSelectedRecordIds((current) => {
        const next = new Set(current)
        next.delete(recordId)
        return next
      })
      setRecordContextMenu((current) =>
        current?.recordId === recordId ? null : current,
      )
      window.dispatchEvent(new CustomEvent('kition:data-document:record:delete', {
        detail: { vaultPath: document.path, tableId: activeTable.id, recordIds: [recordId] },
      }))
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Delete failed',
      )
    } finally {
      setBusy(false)
    }
  }

  async function removeSelectedRecords() {
    if (!document || !activeTable || !records.length) return
    if (!selectedRecordIds.size) return
    const rowKeys = Array.from(selectedRecordIds)
      .map((id) => records.find((record) => record.id === id)?.row_key)
      .filter((key): key is string => Boolean(key))
    if (!rowKeys.length) return
    const idsSnapshot = new Set(selectedRecordIds)
    setBusy(true)
    try {
      if (rowKeys.length > 1) {
        await bulkDeleteDataRecords(document.id, activeTable.id, {
          row_keys: rowKeys,
        })
      } else {
        await Promise.all(
          Array.from(idsSnapshot).map((recordId) =>
            deleteDataRecord(document.id, activeTable.id, recordId),
          ),
        )
      }
      setRecords((items) => items.filter((item) => !idsSnapshot.has(item.id)))
      setSelectedRecordIds(new Set())
      window.dispatchEvent(new CustomEvent('kition:data-document:record:delete', {
        detail: { vaultPath: document.path, tableId: activeTable.id, recordIds: Array.from(idsSnapshot) },
      }))
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Bulk delete failed',
      )
    } finally {
      setBusy(false)
    }
  }

  async function duplicateSelectedRecords() {
    if (!document || !activeTable || !records.length) return
    if (!selectedRecordIds.size) return
    const rowKeys = Array.from(selectedRecordIds)
      .map((id) => records.find((record) => record.id === id)?.row_key)
      .filter((key): key is string => Boolean(key))
    if (!rowKeys.length) return
    setBusy(true)
    try {
      await bulkCopyDataRecords(document.id, activeTable.id, {
        row_keys: rowKeys,
      })
      await loadRecords()
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Bulk copy failed',
      )
    } finally {
      setBusy(false)
    }
  }

  async function reorderRecords(
    sourceRecordId: number,
    targetRecordId: number,
    position: RowDropPosition = 'before',
  ) {
    if (
      !document ||
      !activeTable ||
      !canReorderRows ||
      sourceRecordId === targetRecordId
    )
      return
    const nextRecords = reorderByIdAtPosition(
      records,
      sourceRecordId,
      targetRecordId,
      position,
    ).map((record, index) => ({ ...record, order: index + 1 }))
    setRecords(nextRecords)
    try {
      await Promise.all(
        nextRecords.map((record) =>
          updateDataRecordOrder(
            document.id,
            activeTable.id,
            record.id,
            record.order,
          ),
        ),
      )
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Failed to save row order',
      )
      void loadRecords()
    }
  }

  async function moveKanbanRecord(
    recordId: number,
    group: string,
    targetRecordId?: number,
  ) {
    if (!document || !activeTable || !groupField || !canMoveKanbanCards) return
    const record = records.find((item) => item.id === recordId)
    if (!record) return
    const nextGroupValue = kanbanGroupToValue(groupField, group)
    const nextGroupDisplay = displayValue(nextGroupValue) || 'Empty'
    let nextRecords = records.map((item) =>
      item.id === recordId
        ? {
            ...item,
            values: { ...item.values, [groupField.name]: nextGroupValue },
          }
        : item,
    )

    if (targetRecordId && targetRecordId !== recordId) {
      nextRecords = reorderById(nextRecords, recordId, targetRecordId)
    } else {
      const movedRecord = nextRecords.find((item) => item.id === recordId)
      if (movedRecord) {
        const remainingRecords = nextRecords.filter(
          (item) => item.id !== recordId,
        )
        const insertIndex = remainingRecords.reduce(
          (lastIndex, item, index) => {
            const itemGroup =
              displayValue(item.values?.[groupField.name] ?? null) || 'Empty'
            return itemGroup === nextGroupDisplay ? index + 1 : lastIndex
          },
          remainingRecords.length,
        )
        nextRecords = [
          ...remainingRecords.slice(0, insertIndex),
          movedRecord,
          ...remainingRecords.slice(insertIndex),
        ]
      }
    }

    const orderedRecords = nextRecords.map((item, index) => ({
      ...item,
      order: index + 1,
    }))
    setRecords(orderedRecords)
    try {
      await updateDataRecord(document.id, activeTable.id, recordId, {
        [groupField.name]: nextGroupValue,
      })
      await Promise.all(
        orderedRecords.map((item) =>
          updateDataRecordOrder(
            document.id,
            activeTable.id,
            item.id,
            item.order,
          ),
        ),
      )
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Failed to save card move',
      )
      void loadRecords()
    }
  }

  async function copyRecordURL(record: DataRecord) {
    const base = window.location.href.split('#')[0]
    await copyTextToClipboard(
      `${base}#record-${record.id}`,
      'Record URL copied',
    )
  }

  return {
    addRecord,
    clearCells,
    createRecordFromValues,
    copyRecordURL,
    duplicateRecord,
    duplicateSelectedRecords,
    insertRecordsNear,
    moveKanbanRecord,
    removeRecord,
    removeSelectedRecords,
    reorderRecords,
    runAIField,
    runAIFieldBatchForRecords,
    updateCell,
  }
}
