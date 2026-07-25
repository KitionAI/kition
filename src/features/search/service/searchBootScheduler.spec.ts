import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleSearchBoot } from './searchBootScheduler'

describe('scheduleSearchBoot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps search indexing out of the first two seconds', () => {
    vi.useFakeTimers()
    const callback = vi.fn()

    scheduleSearchBoot(callback)
    vi.advanceTimersByTime(1999)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('cancels a scheduled boot before it starts', () => {
    vi.useFakeTimers()
    const callback = vi.fn()

    const cancel = scheduleSearchBoot(callback)
    cancel()
    vi.runAllTimers()

    expect(callback).not.toHaveBeenCalled()
  })
})
