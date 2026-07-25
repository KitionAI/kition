import { describe, expect, it, beforeEach } from 'vitest'
import {
  aiCellStore,
  buildCellKey,
  type CellStatus,
} from './aiCellGenerationStore'

beforeEach(() => {
  aiCellStore._resetForTests()
})

describe('aiCellStore', () => {
  it('starts idle for an unknown key', () => {
    const status = aiCellStore.get(buildCellKey(1, 2, 3))
    expect(status.status).toBe('idle')
  })

  it('transitions to pending when start is called', () => {
    const key = buildCellKey(1, 2, 3)
    const controller = new AbortController()
    aiCellStore.start(key, 'image_generation', controller)
    const status = aiCellStore.get(key)
    expect(status.status).toBe('pending')
    if (status.status === 'pending') {
      expect(status.action).toBe('image_generation')
      expect(status.controller).toBe(controller)
    }
  })

  it('transitions back to idle when complete is called', () => {
    const key = buildCellKey(1, 2, 3)
    aiCellStore.start(key, 'image_generation', new AbortController())
    aiCellStore.complete(key)
    expect(aiCellStore.get(key).status).toBe('idle')
  })

  it('transitions to error when fail is called', () => {
    const key = buildCellKey(1, 2, 3)
    aiCellStore.start(key, 'image_generation', new AbortController())
    aiCellStore.fail(key, 'boom')
    const status = aiCellStore.get(key)
    expect(status.status).toBe('error')
    if (status.status === 'error') expect(status.message).toBe('boom')
  })

  it('cancel aborts the controller and returns to idle', () => {
    const key = buildCellKey(1, 2, 3)
    const controller = new AbortController()
    aiCellStore.start(key, 'image_generation', controller)
    aiCellStore.cancel(key)
    expect(controller.signal.aborted).toBe(true)
    expect(aiCellStore.get(key).status).toBe('idle')
  })

  it('cancel is a no-op for a key not pending', () => {
    const key = buildCellKey(1, 2, 3)
    aiCellStore.cancel(key)
    expect(aiCellStore.get(key).status).toBe('idle')
  })

  it('subscribers are notified on state change for their key', () => {
    const key = buildCellKey(1, 2, 3)
    let count = 0
    const unsubscribe = aiCellStore.subscribe(key, () => { count += 1 })
    aiCellStore.start(key, 'x', new AbortController())
    aiCellStore.complete(key)
    unsubscribe()
    aiCellStore.start(key, 'x', new AbortController())
    expect(count).toBe(2)
  })

  it('subscribers for one key are not notified on other-key changes', () => {
    const key1 = buildCellKey(1, 2, 3)
    const key2 = buildCellKey(1, 2, 4)
    let count = 0
    aiCellStore.subscribe(key1, () => { count += 1 })
    aiCellStore.start(key2, 'x', new AbortController())
    expect(count).toBe(0)
  })

  it('buildCellKey produces the documented format', () => {
    expect(buildCellKey(10, 20, 30)).toBe('10:20:30')
  })

  it('subscribeAll fires on any key change and getVersion advances', () => {
    let count = 0
    const startVersion = aiCellStore.getVersion()
    const unsubscribe = aiCellStore.subscribeAll(() => { count += 1 })
    aiCellStore.start(buildCellKey(1, 2, 3), 'x', new AbortController())
    aiCellStore.start(buildCellKey(1, 2, 4), 'x', new AbortController())
    expect(count).toBe(2)
    expect(aiCellStore.getVersion()).toBe(startVersion + 2)
    unsubscribe()
    aiCellStore.complete(buildCellKey(1, 2, 3))
    expect(count).toBe(2)
  })
})
