// src/features/search/ui/navigateToHit.spec.tsx
import { describe, it, expect, vi } from 'vitest'
import { navigateToHit } from './navigateToHit'
import type { SearchHit } from '../types'

const baseHit = (over: Partial<SearchHit['doc']>): SearchHit => ({
  id: 'x', score: 1, matches: [],
  doc: {
    id: 'x', kind: 'note', vaultPath: 'a.md', title: 'a', body: '...', tags: [],
    anchor: { kind: 'note', line: 4, ch: 0 },
    ...over,
  } as SearchHit['doc'],
})

describe('navigateToHit', () => {
  it('flashes CM for note hit', async () => {
    const dispatchFlash = vi.fn()
    await navigateToHit(baseHit({}), {
      openVaultPath: vi.fn().mockResolvedValue(undefined),
      getCmViewForPath: () => ({ dispatchFlash }),
      showToast: vi.fn(),
    })
    expect(dispatchFlash).toHaveBeenCalledWith(4, 0, expect.any(Number))
  })

  it('opens the table file of a table_record hit', async () => {
    const openVaultPath = vi.fn().mockResolvedValue(undefined)
    await navigateToHit(baseHit({
      kind: 'table_record', vaultPath: 't.ktable',
      anchor: { kind: 'record', tableId: 't1', recordId: 'r9' },
    }), {
      openVaultPath,
      getCmViewForPath: () => null,
      showToast: vi.fn(),
    })
    expect(openVaultPath).toHaveBeenCalledWith('t.ktable')
  })

  it('toasts when openVaultPath rejects', async () => {
    const showToast = vi.fn()
    await navigateToHit(baseHit({}), {
      openVaultPath: vi.fn().mockRejectedValue(new Error('not found')),
      getCmViewForPath: () => null,
      showToast,
    })
    expect(showToast).toHaveBeenCalledWith('File no longer exists')
  })
})
