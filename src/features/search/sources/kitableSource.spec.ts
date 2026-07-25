import { describe, it, expect } from 'vitest'
import { extractKitableDocs, type KitableTableInput } from './kitableSource'

const FIXTURE: KitableTableInput = {
  vaultPath: 'tables/sales.kitable',
  tableId: 't1',
  tableName: 'Orders',
  fields: [
    { id: 'f1', name: 'Customer', type: 'text' },
    { id: 'f2', name: 'Notes', type: 'long_text' },
    { id: 'f3', name: 'Amount', type: 'number' },
    { id: 'f4', name: 'Status', type: 'single_select' },
    { id: 'f5', name: 'AI Summary', type: 'ai' },
    { id: 'f6', name: 'Attachments', type: 'attachment' },
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

describe('extractKitableDocs', () => {
  const docs = extractKitableDocs(FIXTURE)

  it('produces one record doc per row', () => {
    expect(docs.filter(d => d.kind === 'kitable_record')).toHaveLength(1)
  })

  it('record body contains all indexable cell values joined with field labels', () => {
    const rec = docs.find(d => d.kind === 'kitable_record')!
    expect(rec.body).toContain('Customer: Alex')
    expect(rec.body).toContain('Notes: Revenue anomaly')
    expect(rec.body).toContain('Amount: 12000')
    expect(rec.body).toContain('Status: Completed')
    expect(rec.body).toContain('AI Summary: Customer has a question about quarterly revenue')
    expect(rec.body).toContain('Attachments: receipt.pdf')
    expect(rec.body).toContain('invoice.png')
  })

  it('record tags include kitable:<table-name> and select option labels', () => {
    const rec = docs.find(d => d.kind === 'kitable_record')!
    expect(rec.tags).toContain('kitable:Orders')
    expect(rec.tags).toContain('Completed')
  })

  it('produces meta doc for table, each field, each view', () => {
    const metas = docs.filter(d => d.kind === 'kitable_meta')
    expect(metas).toHaveLength(1 + 6 + 1)
  })

  it('meta docs carry kitable:<table-name> tag', () => {
    const metas = docs.filter(d => d.kind === 'kitable_meta')
    metas.forEach(m => expect(m.tags).toContain('kitable:Orders'))
  })

  it('field meta has metaKind=field and title=field name', () => {
    const fieldMeta = docs.find(
      d => d.kind === 'kitable_meta'
        && d.anchor.kind === 'meta'
        && d.anchor.metaKind === 'field'
        && d.title === 'Notes',
    )
    expect(fieldMeta).toBeDefined()
  })
})
