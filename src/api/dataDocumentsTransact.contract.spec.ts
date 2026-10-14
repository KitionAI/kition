import { describe, expect, it } from 'vitest'

import { expectMatchesContract } from '@/test/contracts'

/**
 * Validates real example payloads against contracts/runtime/data-documents-transact.schema.json
 * and contracts/runtime/table-changed.schema.json with ajv (2020-12). Regression coverage for
 * two schema bugs: `tableRowRef`'s old array-form `items` (invalid in 2020-12, ajv refuses to
 * compile it) and `table-changed`'s `params` rejecting `documentPath` because its `tableChange`
 * branch closed the object with `additionalProperties: false` before the allOf's other branch
 * could contribute `documentPath`.
 */
describe('data document transaction and table/changed contracts', () => {
  const tableChange = {
    documentId: '1',
    origin: 'person:session:3fa85f64-5717-4562-b3fc-2c963f66afa6',
    tables: [11],
    schema: [11],
    views: [201],
    recordsUpserted: [[11, 'r_one']],
    recordsDeleted: [[11, 'r_two']],
    recordsReordered: [11],
    dashboards: false,
  }

  it('accepts a real transact request', () => {
    expectMatchesContract(
      {
        ops: [
          { op: 'cells.set', tableId: 11, records: [{ rowKey: 'r_one', values: { title: 'Updated' } }] },
          { op: 'records.create', tableId: 11, at: { after: 'r_one' }, records: [{ title: 'New row' }] },
          { op: 'records.delete', tableId: 11, rowKeys: ['r_two'] },
          { op: 'records.move', tableId: 11, rowKeys: ['r_one'], before: null },
          { op: 'fields.move', tableId: 11, fieldIds: [102, 101], toIndex: 0 },
        ],
      },
      'data-documents-transact',
      'transactRequest',
    )
  })

  it('accepts a real transact response, including the [tableId, rowKey] tuples', () => {
    expectMatchesContract(
      { change: tableChange, created: ['r_three'] },
      'data-documents-transact',
      'transactResponse',
    )
  })

  it('accepts a real undo/redo response', () => {
    expectMatchesContract({ done: true, change: tableChange }, 'data-documents-transact', 'undoRedoResponse')
  })

  it('accepts a real history-state response', () => {
    expectMatchesContract({ canUndo: true, canRedo: false }, 'data-documents-transact', 'historyStateResponse')
  })

  it('rejects a tableRowRef with the wrong tuple length', () => {
    expect(() => expectMatchesContract(
      { change: { ...tableChange, recordsUpserted: [[11, 'r_one', 'extra']] }, created: [] },
      'data-documents-transact',
      'transactResponse',
    )).toThrow()
  })

  it('accepts a real table/changed event, TableChange plus documentPath', () => {
    expectMatchesContract({ ...tableChange, documentPath: 'Tasks.kitable' }, 'table-changed', 'params')
  })

  it('rejects a table/changed event missing documentPath', () => {
    expect(() => expectMatchesContract(tableChange, 'table-changed', 'params')).toThrow()
  })

  it('rejects a table/changed event with an unrecognized property', () => {
    expect(() => expectMatchesContract(
      { ...tableChange, documentPath: 'Tasks.kitable', unknownField: true },
      'table-changed',
      'params',
    )).toThrow()
  })
})
