import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/dataDocuments'
import * as desktopSettings from '@/services/desktopSettings'
import type { DataField, DataRecord } from '@/types/dataDocument'
import { aiCellStore } from '@/features/table/store/aiCellGenerationStore'

vi.mock('@/services/desktopSettings', () => ({
  loadDesktopSettings: vi.fn(),
}))

import { useTableRecordActions } from './useTableRecordActions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

type RecordActionsArgs = Parameters<typeof useTableRecordActions>[0]
type RecordActions = ReturnType<typeof useTableRecordActions>

let hookContainer: HTMLDivElement | null = null
let hookRoot: Root | null = null

async function mountRecordActions(args: RecordActionsArgs): Promise<RecordActions> {
  const ref: { current: RecordActions | null } = { current: null }
  function Harness() {
    ref.current = useTableRecordActions(args)
    return null
  }

  hookContainer = document.createElement('div')
  document.body.appendChild(hookContainer)
  await act(async () => {
    hookRoot = createRoot(hookContainer!)
    hookRoot.render(createElement(Harness))
    await Promise.resolve()
  })
  return ref.current!
}

afterEach(async () => {
  await act(async () => {
    hookRoot?.unmount()
  })
  hookRoot = null
  hookContainer?.remove()
  hookContainer = null
})

const descriptionField = {
  id: 1,
  name: 'description',
  title: 'Description',
  type: 'long_text',
  is_primary: false,
  readonly: false,
  options: {},
} as unknown as DataField

const aiField = {
  id: 2,
  name: 'image',
  title: 'Image',
  type: 'attachment',
  is_primary: false,
  readonly: false,
  options: {},
  ai_config: {
    type: 'image_generation',
    enabled: true,
    auto_update: true,
    source_field_id: 1,
    n: 1,
    quality: 'medium',
    aspect_ratio: '1:1',
    resolution: '1K',
  },
} as unknown as DataField

const record = {
  id: 100,
  row_key: 'r-100',
  values: { description: 'old' },
  order: 1,
} as unknown as DataRecord

describe('useTableRecordActions auto-update via ai_config.source_field_id', () => {
  beforeEach(() => {
    aiCellStore._resetForTests()
    vi.restoreAllMocks()
    vi.mocked(desktopSettings.loadDesktopSettings).mockResolvedValue({
      models: {
        activeProvider: 'openai',
        selectedModelByProvider: { openai: 'gpt-4o' },
        preferredWritingModel: 'gpt-4o',
        preferredChatModel: 'gpt-4o',
        preferredDefaultModel: 'gpt-4o',
      },
      providers: {
        openai: { apiKey: 'sk-test', baseURL: '', discoveredModels: ['gpt-4o'] },
      },
    } as any)
  })

  it('triggers runAIField on the AI column when its source field changes', async () => {
    const updatedRecord = {
      ...record,
      values: { ...record.values, image: [{ name: 'x.png', url: '/x.png' }] },
    } as unknown as DataRecord

    const runCell = vi
      .spyOn(api, 'runDataAIFieldCell')
      .mockResolvedValue({ record: updatedRecord, field: aiField })
    vi.spyOn(api, 'updateDataRecord').mockResolvedValue(updatedRecord)

    const actions = await mountRecordActions({
      document: { id: 1 } as any,
      activeTable: { id: 2 } as any,
      fields: [descriptionField, aiField],
      records: [record],
      groupField: null,
      canReorderRows: false,
      canMoveKanbanCards: false,
      selectedRecordIds: new Set(),
      setBusy: vi.fn(),
      setError: vi.fn(),
      setRecords: vi.fn(),
      setSelectedRecord: vi.fn(),
      setSelectedRecordIds: vi.fn(),
      setRecordContextMenu: vi.fn(),
      loadRecords: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn(),
      copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    })

    await actions.updateCell(record, descriptionField, 'new value')

    expect(runCell).toHaveBeenCalledWith(
      1,
      2,
      100,
      2,
      expect.objectContaining({ action: 'image_generation' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does NOT trigger runAIField when auto_update is false', async () => {
    const noAutoField = {
      ...aiField,
      ai_config: { ...(aiField as any).ai_config, auto_update: false },
    } as unknown as DataField

    const runCell = vi
      .spyOn(api, 'runDataAIFieldCell')
      .mockResolvedValue({ record, field: noAutoField })
    vi.spyOn(api, 'updateDataRecord').mockResolvedValue(record)

    const actions = await mountRecordActions({
      document: { id: 1 } as any,
      activeTable: { id: 2 } as any,
      fields: [descriptionField, noAutoField],
      records: [record],
      groupField: null,
      canReorderRows: false,
      canMoveKanbanCards: false,
      selectedRecordIds: new Set(),
      setBusy: vi.fn(),
      setError: vi.fn(),
      setRecords: vi.fn(),
      setSelectedRecord: vi.fn(),
      setSelectedRecordIds: vi.fn(),
      setRecordContextMenu: vi.fn(),
      loadRecords: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn(),
      copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    })

    await actions.updateCell(record, descriptionField, 'new value')

    expect(runCell).not.toHaveBeenCalled()
  })

  it('does NOT trigger runAIField when source_field_id points at a different field', async () => {
    const otherSourceField = {
      ...aiField,
      ai_config: { ...(aiField as any).ai_config, source_field_id: 999 },
    } as unknown as DataField

    const runCell = vi
      .spyOn(api, 'runDataAIFieldCell')
      .mockResolvedValue({ record, field: otherSourceField })
    vi.spyOn(api, 'updateDataRecord').mockResolvedValue(record)

    const actions = await mountRecordActions({
      document: { id: 1 } as any,
      activeTable: { id: 2 } as any,
      fields: [descriptionField, otherSourceField],
      records: [record],
      groupField: null,
      canReorderRows: false,
      canMoveKanbanCards: false,
      selectedRecordIds: new Set(),
      setBusy: vi.fn(),
      setError: vi.fn(),
      setRecords: vi.fn(),
      setSelectedRecord: vi.fn(),
      setSelectedRecordIds: vi.fn(),
      setRecordContextMenu: vi.fn(),
      loadRecords: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn(),
      copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    })

    await actions.updateCell(record, descriptionField, 'new value')

    expect(runCell).not.toHaveBeenCalled()
  })
})

describe('useTableRecordActions clearCells', () => {
  beforeEach(() => {
    aiCellStore._resetForTests()
    vi.restoreAllMocks()
  })

  it('groups cells by record, skips readonly and intrinsically non-writable fields, sets null', async () => {
    const textField = {
      id: 10,
      name: 'title',
      title: 'Title',
      type: 'text',
      is_primary: true,
      readonly: false,
      options: {},
    } as unknown as DataField
    const longTextField = {
      id: 11,
      name: 'notes',
      title: 'Notes',
      type: 'long_text',
      is_primary: false,
      readonly: false,
      options: {},
    } as unknown as DataField
    const readonlyField = {
      id: 12,
      name: 'locked',
      title: 'Locked',
      type: 'text',
      is_primary: false,
      readonly: true,
      options: {},
    } as unknown as DataField
    const formulaField = {
      id: 13,
      name: 'formula',
      title: 'Formula',
      type: 'formula',
      is_primary: false,
      readonly: false,
      options: {},
    } as unknown as DataField

    const r1 = { id: 200, row_key: 'r-200', values: { title: 'a', notes: 'n', locked: 'L' }, order: 1 } as unknown as DataRecord
    const r2 = { id: 201, row_key: 'r-201', values: { title: 'b', notes: 'm' }, order: 2 } as unknown as DataRecord

    const updateSpy = vi
      .spyOn(api, 'updateDataRecord')
      .mockImplementation(async (_d: number, _t: number, recordId: number, values: Record<string, any>) =>
        ({ ...(recordId === r1.id ? r1 : r2), values: { ...((recordId === r1.id ? r1 : r2).values || {}), ...values } } as unknown as DataRecord),
      )

    const setRecords = vi.fn()
    const setSelectedRecord = vi.fn()
    const setError = vi.fn()
    const setStatus = vi.fn()

    const actions = await mountRecordActions({
      document: { id: 1 } as any,
      activeTable: { id: 2 } as any,
      fields: [textField, longTextField, readonlyField, formulaField],
      records: [r1, r2],
      groupField: null,
      canReorderRows: false,
      canMoveKanbanCards: false,
      selectedRecordIds: new Set(),
      setBusy: vi.fn(),
      setError,
      setRecords,
      setSelectedRecord,
      setSelectedRecordIds: vi.fn(),
      setRecordContextMenu: vi.fn(),
      loadRecords: vi.fn().mockResolvedValue(undefined),
      setStatus,
      copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    })

    await actions.clearCells([
      { record: r1, field: textField },
      { record: r1, field: longTextField },
      { record: r1, field: readonlyField },
      { record: r1, field: formulaField },
      { record: r2, field: textField },
      { record: r2, field: textField }, // dedup
    ])

    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy).toHaveBeenCalledWith(1, 2, r1.id, { title: null, notes: null })
    expect(updateSpy).toHaveBeenCalledWith(1, 2, r2.id, { title: null })
    expect(setRecords).toHaveBeenCalled()
    expect(setError).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith('Cleared 3 cells')
  })

  it('is a no-op when every cell is unwritable', async () => {
    const formulaField = {
      id: 20,
      name: 'formula',
      title: 'Formula',
      type: 'formula',
      is_primary: false,
      readonly: false,
      options: {},
    } as unknown as DataField
    const r = { id: 300, row_key: 'r-300', values: {}, order: 1 } as unknown as DataRecord

    const updateSpy = vi.spyOn(api, 'updateDataRecord').mockResolvedValue(r)

    const actions = await mountRecordActions({
      document: { id: 1 } as any,
      activeTable: { id: 2 } as any,
      fields: [formulaField],
      records: [r],
      groupField: null,
      canReorderRows: false,
      canMoveKanbanCards: false,
      selectedRecordIds: new Set(),
      setBusy: vi.fn(),
      setError: vi.fn(),
      setRecords: vi.fn(),
      setSelectedRecord: vi.fn(),
      setSelectedRecordIds: vi.fn(),
      setRecordContextMenu: vi.fn(),
      loadRecords: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn(),
      copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
    })

    await actions.clearCells([{ record: r, field: formulaField }])
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
