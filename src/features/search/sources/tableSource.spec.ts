import { describe, it, expect } from 'vitest'
import { extractTableDocs, type TableSearchInput } from './tableSource'

const FIXTURE: TableSearchInput = {
  vaultPath: 'tables/sales.ktable',
  tableId: 't1',
  tableName: 'Orders',
  fields: [
    { id: 'f1', key: 'f1', name: 'Customer', type: 'text' },
    { id: 'f2', key: 'f2', name: 'Notes', type: 'long_text' },
    { id: 'f3', key: 'f3', name: 'Amount', type: 'number' },
    { id: 'f4', key: 'f4', name: 'Status', type: 'single_select' },
    { id: 'f5', key: 'f5', name: 'AI Summary', type: 'ai' },
    { id: 'f6', key: 'f6', name: 'Attachments', type: 'attachment' },
  ],
  views: [{ id: 'v1', name: 'Board View' }],
  records: [
    {
      id: 'r1',
      values: {
        f1: 'Alex',
        f2: 'Revenue anomaly',
        f3: 12000,
        f4: 'Completed',
        f5: 'Customer has a question about quarterly revenue',
        f6: [{ name: 'receipt.pdf', url: '/x' }, { name: 'invoice.png', url: '/y' }],
      },
    },
  ],
}

describe('extractTableDocs', () => {
  const docs = extractTableDocs(FIXTURE)

  it('produces one record doc per row', () => {
    expect(docs.filter(d => d.kind === 'table_record')).toHaveLength(1)
  })

  it('record body contains all indexable cell values joined with field labels', () => {
    const rec = docs.find(d => d.kind === 'table_record')!
    expect(rec.body).toContain('Customer: Alex')
    expect(rec.body).toContain('Notes: Revenue anomaly')
    expect(rec.body).toContain('Amount: 12000')
    expect(rec.body).toContain('Status: Completed')
    expect(rec.body).toContain('AI Summary: Customer has a question about quarterly revenue')
    expect(rec.body).toContain('Attachments: receipt.pdf')
    expect(rec.body).toContain('invoice.png')
  })

  it('record tags include table:<table-name> and select option labels', () => {
    const rec = docs.find(d => d.kind === 'table_record')!
    expect(rec.tags).toContain('table:Orders')
    expect(rec.tags).toContain('Completed')
  })

  it('produces meta doc for table, each field, each view', () => {
    const metas = docs.filter(d => d.kind === 'table_meta')
    expect(metas).toHaveLength(1 + 6 + 1)
  })

  it('meta docs carry table:<table-name> tag', () => {
    const metas = docs.filter(d => d.kind === 'table_meta')
    metas.forEach(m => expect(m.tags).toContain('table:Orders'))
  })

  it('field meta has metaKind=field and title=field name', () => {
    const fieldMeta = docs.find(
      d => d.kind === 'table_meta'
        && d.anchor.kind === 'meta'
        && d.anchor.metaKind === 'field'
        && d.title === 'Notes',
    )
    expect(fieldMeta).toBeDefined()
  })
})
