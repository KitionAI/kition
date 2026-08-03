import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataField, DataRecord, DataTable } from '@/types/dataDocument'

const mocks = vi.hoisted(() => ({
  createDataField: vi.fn(),
  deleteDataField: vi.fn(),
  deleteDataRecord: vi.fn(),
  importDataTableCSV: vi.fn(),
  listDataRecords: vi.fn(),
  updateDataField: vi.fn(),
}))

vi.mock('@/api/dataDocuments', () => mocks)

function makeField(id: number, title: string, type: DataField['type'], order: number): DataField {
  return {
    id,
    user_id: 1,
    document_id: 10,
    table_id: 20,
    name: title.toLocaleLowerCase().replace(/\s+/g, '_'),
    title,
    type,
    required: false,
    unique: false,
    readonly: false,
    is_primary: id === 1,
    order,
    created_at: '',
    updated_at: '',
  }
}

function makeRecord(id: number, values: DataRecord['values']): DataRecord {
  return {
    id,
    user_id: 1,
    document_id: 10,
    table_id: 20,
    row_key: String(id),
    order: id,
    values,
    created_at: '',
    updated_at: '',
  }
}

describe('importCsvIntoDataTable', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.createDataField.mockResolvedValue({})
    mocks.deleteDataField.mockResolvedValue({})
    mocks.deleteDataRecord.mockResolvedValue({})
    mocks.updateDataField.mockResolvedValue({})
    mocks.importDataTableCSV.mockResolvedValue({ created: 2 })
  })

  it('replaces the pristine default schema and removes seeded blank rows', async () => {
    const { importCsvIntoDataTable } = await import('./importCsvIntoDataTable')
    const table = {
      id: 20,
      fields: [
        makeField(1, 'Title', 'text', 1),
        makeField(2, 'Status', 'single_select', 2),
        makeField(3, 'Notes', 'long_text', 3),
      ],
    } as DataTable
    mocks.listDataRecords.mockResolvedValue({
      items: [makeRecord(1, {}), makeRecord(2, {}), makeRecord(3, {})],
      total: 3,
    })

    const result = await importCsvIntoDataTable({
      content: 'Owner,Status,Hours,Link\nalice,Done,2.5,https://example.com/a\nbob,Open,1,https://example.com/b\n',
      documentId: 10,
      table,
    })

    expect(mocks.updateDataField).toHaveBeenNthCalledWith(1, 10, 20, 1, expect.objectContaining({
      title: 'Owner',
      type: 'text',
    }))
    expect(mocks.updateDataField).toHaveBeenNthCalledWith(3, 10, 20, 3, expect.objectContaining({
      title: 'Hours',
      type: 'number',
    }))
    expect(mocks.createDataField).toHaveBeenCalledWith(10, 20, expect.objectContaining({
      title: 'Link',
      type: 'url',
      order: 4,
    }))
    expect(mocks.deleteDataRecord).toHaveBeenCalledTimes(3)
    expect(mocks.importDataTableCSV).toHaveBeenCalledWith(10, 20, expect.stringContaining('Owner,Status,Hours,Link'))
    expect(result).toMatchObject({
      addedFields: 1,
      created: 2,
      fieldCount: 4,
      recordCount: 2,
      replacedDefaultFields: true,
    })
  })

  it('preserves an established schema and adds only missing CSV fields', async () => {
    const { importCsvIntoDataTable } = await import('./importCsvIntoDataTable')
    const table = {
      id: 20,
      fields: [makeField(1, 'Owner', 'text', 1)],
    } as DataTable
    mocks.listDataRecords.mockResolvedValue({
      items: [makeRecord(1, { owner: 'alice' })],
      total: 1,
    })

    const result = await importCsvIntoDataTable({
      content: 'Owner,Hours\nbob,3.5\n',
      documentId: 10,
      table,
    })

    expect(mocks.updateDataField).not.toHaveBeenCalled()
    expect(mocks.deleteDataField).not.toHaveBeenCalled()
    expect(mocks.deleteDataRecord).not.toHaveBeenCalled()
    expect(mocks.createDataField).toHaveBeenCalledTimes(1)
    expect(mocks.createDataField).toHaveBeenCalledWith(10, 20, expect.objectContaining({
      title: 'Hours',
      type: 'number',
    }))
    expect(result).toMatchObject({ addedFields: 1, replacedDefaultFields: false })
  })

  it('replaces a truncated AI import when the default fields contain CSV headers as data', async () => {
    const { importCsvIntoDataTable } = await import('./importCsvIntoDataTable')
    const table = {
      id: 20,
      fields: [
        makeField(1, 'Title', 'text', 1),
        makeField(2, 'Status', 'single_select', 2),
        makeField(3, 'Notes', 'long_text', 3),
      ],
    } as DataTable
    const failedRecords = [
      makeRecord(1, { title: '"Owner', status: '"', notes: '"Full name' }),
      ...Array.from({ length: 13 }, (_, index) => makeRecord(index + 2, {
        title: `owner-${index}`,
        status: '',
        notes: `Person ${index}`,
      })),
    ]
    mocks.listDataRecords.mockResolvedValue({ items: failedRecords, total: failedRecords.length })

    const result = await importCsvIntoDataTable({
      content: 'Owner,Full name,Project,Hours\nalice,Alice,Core,2.5\nbob,Bob,Core,1\n',
      documentId: 10,
      table,
    })

    expect(mocks.updateDataField).toHaveBeenCalledTimes(3)
    expect(mocks.createDataField).toHaveBeenCalledTimes(1)
    expect(mocks.deleteDataRecord).toHaveBeenCalledTimes(14)
    expect(result).toMatchObject({
      recoveredFailedImport: true,
      replacedDefaultFields: true,
    })
  })
})
