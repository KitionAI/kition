import { describe, it, expect, vi } from 'vitest'
import { listTableFileStamps } from '@/api/kitTables'
import { extractTableDocs, syncTableSearchDocs, type TableSearchFile, type TableSearchInput } from './tableSource'

vi.mock('@/api/kitTables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/kitTables')>()),
  listTableFileStamps: vi.fn(),
}))

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

describe('syncTableSearchDocs', () => {
  function index() {
    const calls: Array<[string, ...unknown[]]> = []
    return {
      calls,
      upsert: vi.fn(async (docs: unknown[], stamps?: Record<string, string>) => void calls.push(['upsert', docs.length, stamps])),
      removeByVaultPath: vi.fn(async (paths: string[]) => void calls.push(['remove', paths])),
    }
  }
  const file = (vaultPath: string, stamp: string): TableSearchFile => ({ stamp, tables: [{ ...FIXTURE, vaultPath }] })

  it('reads only the table files that are new or written since they were indexed, and drops the gone', async () => {
    vi.mocked(listTableFileStamps).mockResolvedValue({ files: [
      { path: 'Same.ktable', stamp: '1-10' },
      { path: 'Changed.ktable', stamp: '2-20' },
      { path: 'New.ktable', stamp: '3-30' },
    ] })
    const target = index()
    const load = vi.fn(async (path: string) => file(path, path === 'Changed.ktable' ? '2-20' : '3-30'))
    const outcome = await syncTableSearchDocs(target, { 'Same.ktable': '1-10', 'Changed.ktable': '1-19', 'Gone.ktable': '0-1' }, () => false, load)
    expect(load.mock.calls.map(([path]) => path)).toEqual(['Changed.ktable', 'New.ktable'])
    expect(target.calls[0]).toEqual(['remove', ['Gone.ktable']])
    expect(target.calls).toContainEqual(['upsert', extractTableDocs(FIXTURE).length, { 'Changed.ktable': '2-20' }])
    expect(target.calls).toContainEqual(['upsert', extractTableDocs(FIXTURE).length, { 'New.ktable': '3-30' }])
    expect(outcome).toEqual({ files: 3, read: 2, removed: 1, failed: 0 })
  })

  it('reads nothing when nothing changed, keeps going past a file that fails, and stops when cancelled', async () => {
    vi.mocked(listTableFileStamps).mockResolvedValue({ files: [{ path: 'A.ktable', stamp: '1' }, { path: 'B.ktable', stamp: '2' }] })
    const load = vi.fn(async (path: string) => file(path, '9'))
    expect(await syncTableSearchDocs(index(), { 'A.ktable': '1', 'B.ktable': '2' }, () => false, load)).toEqual({ files: 2, read: 0, removed: 0, failed: 0 })
    expect(load).not.toHaveBeenCalled()

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = vi.fn(async (path: string) => {
      if (path === 'A.ktable') throw new Error('kit unavailable')
      return file(path, '2')
    })
    expect(await syncTableSearchDocs(index(), {}, () => false, failing)).toEqual({ files: 2, read: 1, removed: 0, failed: 1 })

    let reads = 0
    const counting = vi.fn(async (path: string) => {
      reads += 1
      return file(path, '1')
    })
    await syncTableSearchDocs(index(), {}, () => reads >= 1, counting)
    expect(counting).toHaveBeenCalledTimes(1)
  })
})
