import { afterEach, describe, expect, it, vi } from 'vitest'

import { mayLeaveDesktop, setDesktopLeaveGuard } from './desktopLeave'

let withdraw: (() => void) | null = null

afterEach(() => {
  withdraw?.()
  withdraw = null
  vi.restoreAllMocks()
})

describe('desktopLeave', () => {
  it('lets the window leave when no guard is registered', async () => {
    await expect(mayLeaveDesktop('quit')).resolves.toBe(true)
  })

  it('asks the guard, with what is leaving', async () => {
    const guard = vi.fn(async () => false)
    withdraw = setDesktopLeaveGuard(guard)
    await expect(mayLeaveDesktop('close')).resolves.toBe(false)
    expect(guard).toHaveBeenCalledWith('close')
  })

  it('stays when the guard fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    withdraw = setDesktopLeaveGuard(async () => {
      throw new Error('broken')
    })
    await expect(mayLeaveDesktop('reload')).resolves.toBe(false)
  })

  it('a withdrawn guard is no longer asked, and withdrawing an older one keeps the newer', async () => {
    const first = setDesktopLeaveGuard(async () => false)
    withdraw = setDesktopLeaveGuard(async () => false)
    first()
    await expect(mayLeaveDesktop('quit')).resolves.toBe(false)
    withdraw()
    withdraw = null
    await expect(mayLeaveDesktop('quit')).resolves.toBe(true)
  })
})
