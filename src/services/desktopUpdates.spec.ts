import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackProductEvent = vi.hoisted(() => vi.fn())

vi.mock('@/features/analytics/lib/productAnalytics', () => ({ trackProductEvent }))

const bridgeStub = {
  UpdatesGetState: vi.fn(),
  UpdatesCheck: vi.fn(),
  UpdatesDownload: vi.fn(),
  UpdatesInstall: vi.fn(),
  UpdatesSetBetaChannel: vi.fn(),
  EventsOn: vi.fn(),
  updatesEvent: 'desktop:updates:state',
}

beforeEach(() => {
  trackProductEvent.mockReset()
  ;(globalThis as any).kitionDesktop = bridgeStub
  Object.values(bridgeStub).forEach((v) => typeof v === 'function' && (v as any).mockReset?.())
  bridgeStub.EventsOn.mockImplementation(() => () => {})
})

afterEach(() => {
  delete (globalThis as any).kitionDesktop
})

describe('desktopUpdates service', () => {
  it('falls back to unsupported when no bridge is present', async () => {
    delete (globalThis as any).kitionDesktop
    const mod = await import('./desktopUpdates')
    await expect(mod.getUpdateState()).resolves.toEqual({ phase: 'unsupported', reason: 'web preview' })
  })

  it('forwards getUpdateState to the bridge', async () => {
    bridgeStub.UpdatesGetState.mockResolvedValue({ phase: 'idle' })
    const mod = await import('./desktopUpdates')
    await expect(mod.getUpdateState()).resolves.toEqual({ phase: 'idle' })
    expect(bridgeStub.UpdatesGetState).toHaveBeenCalledTimes(1)
  })

  it('forwards checkForUpdates, downloadUpdate, installUpdate, setBetaChannel', async () => {
    bridgeStub.UpdatesCheck.mockResolvedValue({ phase: 'checking' })
    bridgeStub.UpdatesDownload.mockResolvedValue(undefined)
    bridgeStub.UpdatesInstall.mockResolvedValue(undefined)
    bridgeStub.UpdatesSetBetaChannel.mockResolvedValue(undefined)
    const mod = await import('./desktopUpdates')
    await mod.checkForUpdates()
    await mod.downloadUpdate()
    await mod.installUpdate()
    await mod.setBetaChannel(true)
    expect(bridgeStub.UpdatesCheck).toHaveBeenCalled()
    expect(bridgeStub.UpdatesDownload).toHaveBeenCalled()
    expect(bridgeStub.UpdatesInstall).toHaveBeenCalled()
    expect(bridgeStub.UpdatesSetBetaChannel).toHaveBeenCalledWith(true)
    expect(trackProductEvent).toHaveBeenCalledWith('update_check_completed', {
      result: 'success',
      update_state: 'checking',
    })
    expect(trackProductEvent).toHaveBeenCalledWith('update_install_completed', {
      result: 'success',
      update_state: 'downloaded',
    })
  })

  it('forwards setAutoCheckUpdates to the bridge', async () => {
    (bridgeStub as any).UpdatesSetAutoCheck = vi.fn(async () => {})
    const mod = await import('./desktopUpdates')
    await mod.setAutoCheckUpdates(false)
    expect((bridgeStub as any).UpdatesSetAutoCheck).toHaveBeenCalledWith(false)
  })

  it('subscribeToUpdates wires the bridge event and returns a disposer', async () => {
    const off = vi.fn()
    bridgeStub.EventsOn.mockReturnValue(off)
    const mod = await import('./desktopUpdates')
    const cb = vi.fn()
    const dispose = mod.subscribeToUpdates(cb)
    expect(bridgeStub.EventsOn).toHaveBeenCalledWith('desktop:updates:state', cb)
    dispose()
    expect(off).toHaveBeenCalled()
  })

  it('subscribeToUpdates is a no-op disposer when no bridge', async () => {
    delete (globalThis as any).kitionDesktop
    const mod = await import('./desktopUpdates')
    const dispose = mod.subscribeToUpdates(() => {})
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})
