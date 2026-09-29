import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectMatchesContract } from '@/test/contracts'
import { DATA_DOCUMENTS_FS_LISTING_CAPABILITY, runtimeListsTablesFromFileSystem } from './dataDocuments'

describe('data document listing contract', () => {
  it('keeps the capability name in lockstep with the contract', () => {
    const schema = JSON.parse(readFileSync(resolve('contracts/runtime/data-documents-listing.schema.json'), 'utf8'))
    expect(schema['x-runtime-capability']).toBe(DATA_DOCUMENTS_FS_LISTING_CAPABILITY)
    expect(runtimeListsTablesFromFileSystem([DATA_DOCUMENTS_FS_LISTING_CAPABILITY])).toBe(true)
    expect(runtimeListsTablesFromFileSystem(['documents'])).toBe(false)
    expect(runtimeListsTablesFromFileSystem()).toBe(false)
  })

  it('accepts the listing the runtime returns', () => {
    expectMatchesContract(
      { items: [{ id: 7, path: 'Projects/Leads.kitable', title: 'Leads', workspace_root: 'workspace' }], total: 1 },
      'data-documents-listing',
    )
    expect(() => expectMatchesContract({ items: [{ id: 0, path: '', title: 'x' }], total: 1 }, 'data-documents-listing')).toThrow()
  })
})
