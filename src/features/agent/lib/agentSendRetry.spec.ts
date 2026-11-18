import { describe, expect, it, vi } from 'vitest'

import { isSessionBusyError, retryWhileSessionBusy } from './agentSendRetry'

const busy = () => Object.assign(new Error('This session is still answering.'), { status: 409 })

describe('retryWhileSessionBusy', () => {
  it('recognises only the busy-session refusal', () => {
    expect(isSessionBusyError(busy())).toBe(true)
    expect(isSessionBusyError(Object.assign(new Error('conflict'), { status: 409 }))).toBe(false)
    expect(isSessionBusyError(new Error('This session is still answering.'))).toBe(false)
    expect(isSessionBusyError('still answering')).toBe(false)
  })

  it('retries a busy session and then succeeds', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValueOnce('done')
    await expect(retryWhileSessionBusy(send, { delayMs: 1 })).resolves.toBe('done')
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('gives up after five retries', async () => {
    const send = vi.fn().mockRejectedValue(busy())
    await expect(retryWhileSessionBusy(send, { delayMs: 1 })).rejects.toThrow('still answering')
    expect(send).toHaveBeenCalledTimes(6)
  })

  it('does not retry other errors or an aborted send', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(retryWhileSessionBusy(failing, { delayMs: 1 })).rejects.toThrow('offline')
    expect(failing).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    controller.abort()
    const aborted = vi.fn().mockRejectedValue(busy())
    await expect(retryWhileSessionBusy(aborted, { signal: controller.signal, delayMs: 1 })).rejects.toThrow()
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})
