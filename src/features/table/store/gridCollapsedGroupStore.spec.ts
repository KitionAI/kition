import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  getCollapsedGroupIds,
  setCollapsedGroupIds,
  subscribeCollapsedGroups,
  __resetCollapsedGroupStoreForTests,
} from './gridCollapsedGroupStore'

describe('gridCollapsedGroupStore', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetCollapsedGroupStoreForTests()
  })

  afterEach(() => {
    localStorage.clear()
    __resetCollapsedGroupStoreForTests()
  })

  it('returns an empty Set for an unknown viewId', () => {
    expect(getCollapsedGroupIds('v1').size).toBe(0)
  })

  it('round-trips writes through localStorage', () => {
    setCollapsedGroupIds('v1', new Set(['g0:"Done"']))
    expect(Array.from(getCollapsedGroupIds('v1'))).toEqual(['g0:"Done"'])

    const raw = localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ v1: ['g0:"Done"'] })
  })

  it('keeps viewIds isolated from one another', () => {
    setCollapsedGroupIds('v1', new Set(['a']))
    setCollapsedGroupIds('v2', new Set(['b']))

    expect(Array.from(getCollapsedGroupIds('v1'))).toEqual(['a'])
    expect(Array.from(getCollapsedGroupIds('v2'))).toEqual(['b'])
  })

  it('hydrates existing localStorage on first read', () => {
    localStorage.setItem(
      COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify({ v9: ['g0:"X"'] }),
    )
    __resetCollapsedGroupStoreForTests()
    expect(Array.from(getCollapsedGroupIds('v9'))).toEqual(['g0:"X"'])
  })

  it('notifies subscribers when any viewId is written', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCollapsedGroups(listener)
    setCollapsedGroupIds('v1', new Set(['a']))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    setCollapsedGroupIds('v1', new Set(['b']))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('returns the same Set reference between writes for stable useSyncExternalStore snapshots', () => {
    setCollapsedGroupIds('v1', new Set(['a']))
    const first = getCollapsedGroupIds('v1')
    const second = getCollapsedGroupIds('v1')
    expect(first).toBe(second)
  })

  it('silently tolerates corrupt localStorage payload', () => {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, '{not json')
    __resetCollapsedGroupStoreForTests()
    expect(getCollapsedGroupIds('v1').size).toBe(0)
  })

  it('clones the input set so caller mutations do not leak into the store', () => {
    const input = new Set(['a'])
    setCollapsedGroupIds('v1', input)
    input.add('b')
    expect(Array.from(getCollapsedGroupIds('v1'))).toEqual(['a'])
  })
})
