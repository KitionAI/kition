import { beforeEach, describe, expect, it } from 'vitest'

import {
  isTabPinned,
  listPinnedTabs,
  pinTab,
  setPinnedTabsWorkspace,
  togglePinTab,
  unpinTab,
} from './usePinnedTabs'

const ROOT_A = '/Users/alice/vault-a'
const ROOT_B = '/Users/alice/vault-b'

describe('usePinnedTabs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setPinnedTabsWorkspace('')
  })

  it('returns no tabs and no-ops on writes when no workspace is set', () => {
    pinTab('note.md')
    expect(listPinnedTabs()).toEqual([])
    expect(window.localStorage.getItem('kition.document.pinnedTabs.v2')).toBeNull()
  })

  it('isolates pinned tabs across workspaces', () => {
    setPinnedTabsWorkspace(ROOT_A)
    pinTab('a.md')
    pinTab('a2.md')

    setPinnedTabsWorkspace(ROOT_B)
    expect(listPinnedTabs()).toEqual([])
    pinTab('b.md')

    setPinnedTabsWorkspace(ROOT_A)
    expect(listPinnedTabs()).toEqual(['a2.md', 'a.md'])
    expect(isTabPinned('a.md')).toBe(true)
    expect(isTabPinned('b.md')).toBe(false)

    setPinnedTabsWorkspace(ROOT_B)
    expect(listPinnedTabs()).toEqual(['b.md'])
  })

  it('togglePinTab and unpinTab only touch the active workspace', () => {
    setPinnedTabsWorkspace(ROOT_A)
    pinTab('a.md')

    setPinnedTabsWorkspace(ROOT_B)
    pinTab('b.md')
    togglePinTab('b.md') // unpins
    expect(listPinnedTabs()).toEqual([])

    setPinnedTabsWorkspace(ROOT_A)
    expect(listPinnedTabs()).toEqual(['a.md'])
    unpinTab('a.md')
    expect(listPinnedTabs()).toEqual([])
  })

  it('migrates legacy document.pinnedTabs array into the first workspace that reads it', () => {
    window.localStorage.setItem(
      'kition.document.pinnedTabs',
      JSON.stringify(['legacy-1.md', 'legacy-2.md']),
    )

    setPinnedTabsWorkspace(ROOT_A)
    expect(listPinnedTabs()).toEqual(['legacy-1.md', 'legacy-2.md'])
    expect(window.localStorage.getItem('kition.document.pinnedTabs')).toBeNull()

    setPinnedTabsWorkspace(ROOT_B)
    expect(listPinnedTabs()).toEqual([])
  })
})
