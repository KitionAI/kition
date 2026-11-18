import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProxyState, restartBackend, saveProxyState, testProxy } from './desktopProxy'
import { createDefaultDesktopProxyConfig, createDefaultDesktopProxyState } from '@/types/desktopProxy'

afterEach(() => vi.unstubAllGlobals())

describe('desktop proxy service', () => {
  it('keeps web preview disabled and reports unsupported network operations', async () => {
    vi.stubGlobal('kitionDesktop', undefined)
    await expect(getProxyState()).resolves.toEqual(createDefaultDesktopProxyState())
    await expect(saveProxyState(createDefaultDesktopProxyConfig())).resolves.toEqual({
      state: createDefaultDesktopProxyState(), requiresRestart: false,
    })
    await expect(testProxy()).resolves.toEqual({ ok: false, message: 'web preview: not supported' })
    await expect(restartBackend()).resolves.toEqual({ ok: false, message: 'web preview: not supported' })
  })

  it('preserves password update semantics and leaves restart to the caller', async () => {
    const state = { ...createDefaultDesktopProxyState(), enabled: true, host: 'proxy.example.test', port: 8080, hasPassword: true }
    const bridge = {
      ProxyGet: vi.fn().mockResolvedValue(state),
      ProxySave: vi.fn().mockResolvedValue({ state, requiresRestart: true }),
      ProxyRestartBackend: vi.fn().mockResolvedValue({ ok: true }),
    }
    vi.stubGlobal('kitionDesktop', bridge)
    await expect(getProxyState()).resolves.toEqual(state)
    const config = { ...createDefaultDesktopProxyConfig(), enabled: true, host: state.host, port: state.port }
    for (const payload of [config, { ...config, password: '' }, { ...config, password: 'fixture-password' }]) {
      await expect(saveProxyState(payload)).resolves.toEqual({ state, requiresRestart: true })
      expect(bridge.ProxySave).toHaveBeenLastCalledWith(payload)
    }
    expect(bridge.ProxyRestartBackend).not.toHaveBeenCalled()
    await expect(restartBackend()).resolves.toEqual({ ok: true })
    expect(bridge.ProxyRestartBackend).toHaveBeenCalledTimes(1)
  })

  it('tests unsaved settings without saving or restarting the backend', async () => {
    const bridge = {
      ProxyTest: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12 }),
      ProxySave: vi.fn(),
      ProxyRestartBackend: vi.fn(),
    }
    vi.stubGlobal('kitionDesktop', bridge)
    const payload = { ...createDefaultDesktopProxyConfig(), host: 'proxy.example.test', port: 8080 }
    await expect(testProxy(payload)).resolves.toEqual({ ok: true, latencyMs: 12 })
    expect(bridge.ProxyTest).toHaveBeenCalledWith(payload)
    expect(bridge.ProxySave).not.toHaveBeenCalled()
    expect(bridge.ProxyRestartBackend).not.toHaveBeenCalled()
  })

  it('propagates bridge failures so the settings screen can report them', async () => {
    vi.stubGlobal('kitionDesktop', {
      ProxySave: vi.fn().mockRejectedValue(new Error('Could not persist proxy settings')),
    })
    await expect(saveProxyState(createDefaultDesktopProxyConfig())).rejects.toThrow('Could not persist proxy settings')
  })
})
