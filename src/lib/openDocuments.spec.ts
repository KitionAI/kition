import { describe, expect, it, vi } from 'vitest'
import { createOpenDocumentRegistry } from './openDocuments'

describe('createOpenDocumentRegistry', () => {
  it('announces documents open now and later, and runs their cleanup when they close', () => {
    const registry = createOpenDocumentRegistry<{ path: string; name: string }>()
    const withdrawA = registry.register({ path: 'a.md', name: 'A' })
    const closed = vi.fn()
    const seen: string[] = []
    const unfollow = registry.follow((document) => {
      seen.push(document.name)
      return () => closed(document.name)
    })
    const withdrawB = registry.register({ path: 'b.md', name: 'B' })
    expect(seen).toEqual(['A', 'B'])
    expect(registry.find('b.md')?.name).toBe('B')
    withdrawA()
    expect(closed).toHaveBeenCalledWith('A')
    expect(registry.find('a.md')).toBeNull()
    unfollow()
    expect(closed).toHaveBeenCalledWith('B')
    withdrawB()
    expect(closed).toHaveBeenCalledTimes(2)
  })

  it('announces a path open twice once, and hands it to the second registration when the first goes', () => {
    const registry = createOpenDocumentRegistry<{ path: string; tab: number }>()
    const seen: number[] = []
    const closed: number[] = []
    registry.follow((document) => {
      seen.push(document.tab)
      return () => closed.push(document.tab)
    })
    const first = registry.register({ path: 'Tasks.kitable', tab: 1 })
    const second = registry.register({ path: 'Tasks.kitable', tab: 2 })
    expect(seen).toEqual([1])
    first()
    expect(closed).toEqual([1])
    expect(seen).toEqual([1, 2])
    expect(registry.find('Tasks.kitable')?.tab).toBe(2)
    second()
    expect(closed).toEqual([1, 2])
    expect(registry.find('Tasks.kitable')).toBeNull()
    // Withdrawing twice changes nothing.
    second()
    expect(closed).toEqual([1, 2])
  })
})
