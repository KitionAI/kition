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
      getKitableHandle: () => null,
      showToast: vi.fn(),
    })
    expect(dispatchFlash).toHaveBeenCalledWith(4, 0, expect.any(Number))
  })

  it('focuses record for kitable_record hit', async () => {
    const focusRecord = vi.fn()
    await navigateToHit(baseHit({
      kind: 'kitable_record', vaultPath: 't.kitable',
      anchor: { kind: 'record', tableId: 't1', recordId: 'r9' },
    }), {
      openVaultPath: vi.fn().mockResolvedValue(undefined),
      getCmViewForPath: () => null,
      getKitableHandle: () => ({ focusRecord, focusFieldHeader: vi.fn(), switchToView: vi.fn() }),
      showToast: vi.fn(),
    })
    expect(focusRecord).toHaveBeenCalledWith('r9', undefined)
  })

  it('toasts when openVaultPath rejects', async () => {
    const showToast = vi.fn()
    await navigateToHit(baseHit({}), {
      openVaultPath: vi.fn().mockRejectedValue(new Error('not found')),
      getCmViewForPath: () => null,
      getKitableHandle: () => null,
      showToast,
    })
    expect(showToast).toHaveBeenCalledWith('File no longer exists')
  })
})
