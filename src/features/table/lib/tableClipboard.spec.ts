import { describe, expect, it } from 'vitest'

import { CombinedSelection, SelectionRegionType } from '@/features/table/grid'
import type { DataField, DataRecord } from '@/types/dataDocument'

import { serializeTableSelection } from './tableClipboard'

const fields = [
  { name: 'subject' },
  { name: 'status' },
  { name: 'message_id' },
] as DataField[]

const records = [
  { values: { subject: 'First', status: 'Imported', message_id: 'one' } },
  { values: { subject: 'Second', status: 'Pending', message_id: 'two' } },
] as unknown as DataRecord[]

describe('serializeTableSelection', () => {
  it('copies a rectangular cell selection as tab-separated rows', () => {
    const selection = new CombinedSelection(SelectionRegionType.Cells, [[0, 0], [1, 1]])

    expect(serializeTableSelection(selection, fields, records)).toBe(
      'First\tImported\nSecond\tPending',
    )
  })

  it('copies complete rows for a row selection', () => {
    const selection = new CombinedSelection(SelectionRegionType.Rows, [[1, 1]])

    expect(serializeTableSelection(selection, fields, records)).toBe('Second\tPending\ttwo')
  })

  it('quotes tabs and line breaks so spreadsheet pastes stay intact', () => {
    const selection = new CombinedSelection(SelectionRegionType.Cells, [[0, 0], [0, 0]])
    const multilineRecords = [
      { values: { subject: 'Hello\tworld\n"quoted"' } },
    ] as unknown as DataRecord[]

    expect(serializeTableSelection(selection, fields, multilineRecords)).toBe(
      '"Hello\tworld\n""quoted"""',
    )
  })

  it('copies date fields using the same readable format shown in the table', () => {
    const selection = new CombinedSelection(SelectionRegionType.Cells, [[0, 0], [1, 0]])
    const dateFields = [
      { name: 'received_on', type: 'date' },
      { name: 'received_at', type: 'datetime' },
    ] as DataField[]
    const dateRecords = [{
      values: {
        received_on: '2026-07-23',
        received_at: '2026-07-23T04:14:47Z',
      },
    }] as unknown as DataRecord[]

    const copied = serializeTableSelection(selection, dateFields, dateRecords)
    expect(copied).not.toContain('2026-07-23T04:14:47Z')
    expect(copied).toContain('2026')
  })
})
