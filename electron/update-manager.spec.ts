import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const autoUpdaterMock = {
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  logger: null as any,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
}

vi.mock('electron-updater', () => ({ default: { autoUpdater: autoUpdaterMock } }))
vi.mock('electron-log/node.js', () => ({ default: { transports: { file: { level: 'info' } } } }))

async function loadModule() {
  vi.resetModules()
  return import('./update-manager.mjs')
}

beforeEach(() => {
  autoUpdaterMock.on.mockReset()
  autoUpdaterMock.checkForUpdates.mockReset()
  autoUpdaterMock.downloadUpdate.mockReset()
  autoUpdaterMock.quitAndInstall.mockReset()
  autoUpdaterMock.autoDownload = true
  autoUpdaterMock.autoInstallOnAppQuit = true
  autoUpdaterMock.allowPrerelease = false
})

afterEach(() => vi.useRealTimers())

describe('UpdateManager state container', () => {
  it('starts in idle phase', async () => {
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({ getMainWindow: () => null, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: false })
    expect(mgr.state.phase).toBe('idle')
  })

  it('configures electron-updater to require explicit user action', async () => {
    await loadModule()
    expect(autoUpdaterMock.autoDownload).toBe(false)
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
  })

  it('broadcasts state changes to the main window webContents', async () => {
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({ getMainWindow: () => win, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: true })
    mgr.set({ phase: 'checking' })
    expect(send).toHaveBeenCalledWith('desktop:updates:state', { phase: 'checking' })
    expect(mgr.state).toEqual({ phase: 'checking' })
  })

  it('does not broadcast when main window is missing or destroyed', async () => {
    const send = vi.fn()
    const { UpdateManager } = await loadModule()
    const mgr1 = new UpdateManager({ getMainWindow: () => null, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: true })
    mgr1.set({ phase: 'checking' })
    expect(send).not.toHaveBeenCalled()

    const mgr2 = new UpdateManager({
      getMainWindow: () => ({ isDestroyed: () => true, webContents: { send } }),
      getBetaChannel: () => false,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    mgr2.set({ phase: 'checking' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('UpdateManager event bindings', () => {
  function makeManager() {
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    return {
      send,
      win,
      build: async () => {
        const { UpdateManager } = await loadModule()
        const mgr = new UpdateManager({ getMainWindow: () => win, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: true })
        mgr.bindEvents()
        return mgr
      },
    }
  }

  function fire(event, payload) {
    const call = autoUpdaterMock.on.mock.calls.find((c) => c[0] === event)
    if (!call) throw new Error(`no handler registered for ${event}`)
    call[1](payload)
  }

  it('transitions to checking on checking-for-update', async () => {
    const { build } = makeManager()
    const mgr = await build()
    fire('checking-for-update', undefined)
    expect(mgr.state).toEqual({ phase: 'checking' })
  })

  it('transitions to available with version + notes', async () => {
    const { build } = makeManager()
    const mgr = await build()
    fire('update-available', { version: '1.0.1', releaseNotes: 'fixed', releaseDate: '2026-06-15' })
    expect(mgr.state).toEqual({
      phase: 'available', version: '1.0.1', releaseNotes: 'fixed', releaseDate: '2026-06-15',
    })
  })

  it('transitions to up-to-date with current version', async () => {
    const { build } = makeManager()
    const mgr = await build()
    fire('update-not-available', { version: '1.0.0' })
    expect(mgr.state).toEqual({ phase: 'up-to-date', currentVersion: '1.0.0' })
  })

  it('transitions to downloaded with version', async () => {
    const { build } = makeManager()
    const mgr = await build()
    fire('update-downloaded', { version: '1.0.1' })
    expect(mgr.state).toEqual({ phase: 'downloaded', version: '1.0.1' })
  })

  it('classifies error and stores phaseAtError', async () => {
    const { build } = makeManager()
    const mgr = await build()
    fire('checking-for-update', undefined)
    fire('error', new Error('ENOTFOUND github.com'))
    expect(mgr.state.phase).toBe('error')
    expect(mgr.state.errorKind).toBe('network')
    expect(mgr.state.message).toContain('ENOTFOUND')
    expect(mgr.state.phaseAtError).toBe('checking')
  })
})

describe('UpdateManager download progress throttling', () => {
  it('broadcasts the first progress event immediately', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({ getMainWindow: () => win, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: true })
    mgr.bindEvents()
    const call = autoUpdaterMock.on.mock.calls.find((c) => c[0] === 'download-progress')
    call[1]({ percent: 12, transferred: 120, total: 1000, bytesPerSecond: 60 })
    expect(send).toHaveBeenCalledWith('desktop:updates:state', expect.objectContaining({ phase: 'downloading', percent: 12 }))
  })

  it('coalesces rapid progress events within the throttle window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({ getMainWindow: () => win, getBetaChannel: () => false, getAutoCheck: () => true, isPackaged: true })
    mgr.bindEvents()
    const handler = autoUpdaterMock.on.mock.calls.find((c) => c[0] === 'download-progress')[1]
    handler({ percent: 10, transferred: 100, total: 1000, bytesPerSecond: 50 })
    vi.setSystemTime(1_000_100)   // 100ms later
    handler({ percent: 11, transferred: 110, total: 1000, bytesPerSecond: 50 })
    vi.setSystemTime(1_000_300)   // 300ms after first
    handler({ percent: 13, transferred: 130, total: 1000, bytesPerSecond: 50 })
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('UpdateManager commands', () => {
  async function makeManager({ packaged = true, beta = false, autoCheck = true } = {}) {
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => win,
      getBetaChannel: () => beta,
      getAutoCheck: () => autoCheck,
      isPackaged: packaged,
    })
    mgr.bindEvents()
    return mgr
  }

  it('check() reports unsupported when app is not packaged', async () => {
    const mgr = await makeManager({ packaged: false })
    const result = await mgr.check()
    expect(result.phase).toBe('unsupported')
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('check() refreshes allowPrerelease from getBetaChannel before each call', async () => {
    let beta = false
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => beta,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    await mgr.check()
    expect(autoUpdaterMock.allowPrerelease).toBe(false)
    beta = true
    await mgr.check()
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
  })

  it('check() is a no-op while already checking, downloading, or downloaded', async () => {
    const mgr = await makeManager()
    for (const phase of ['checking', 'downloading', 'downloaded']) {
      mgr.state = { phase }
      autoUpdaterMock.checkForUpdates.mockClear()
      await mgr.check()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    }
  })

  it('download() throws unless phase is available', async () => {
    const mgr = await makeManager()
    mgr.state = { phase: 'idle' }
    await expect(mgr.download()).rejects.toThrow(/no update to download/i)
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    mgr.state = { phase: 'available', version: '1.0.1' }
    await mgr.download()
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalled()
  })

  it('quitAndInstall() throws unless phase is downloaded', async () => {
    const mgr = await makeManager()
    mgr.state = { phase: 'available', version: '1.0.1' }
    expect(() => mgr.quitAndInstall()).toThrow(/no downloaded update/i)
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    mgr.state = { phase: 'downloaded', version: '1.0.1' }
    mgr.quitAndInstall()
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('setBetaChannel(true) updates allowPrerelease and triggers a re-check when value changes', async () => {
    const beta = { current: false }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => beta.current,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    beta.current = true
    await mgr.setBetaChannel(true)
    expect(autoUpdaterMock.allowPrerelease).toBe(true)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('setBetaChannel does not re-check when flag is unchanged', async () => {
    const beta = { current: false }
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => beta.current,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    autoUpdaterMock.allowPrerelease = false
    await mgr.setBetaChannel(false)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})

describe('UpdateManager lifecycle', () => {
  it('start() sets unsupported and schedules nothing when not packaged', async () => {
    vi.useFakeTimers()
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => false,
      getAutoCheck: () => true,
      isPackaged: false,
    })
    await mgr.start()
    expect(mgr.state.phase).toBe('unsupported')
    expect(mgr.timer).toBeNull()
  })

  it('start() schedules the first check 30s later and a periodic 6h interval', async () => {
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => false,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    mgr.bindEvents()
    await mgr.start()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
    mgr.stop()
  })

  it('start() skips auto checks entirely when getAutoCheck returns false', async () => {
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => false,
      getAutoCheck: () => false,
      isPackaged: true,
    })
    mgr.bindEvents()
    await mgr.start()
    await vi.advanceTimersByTimeAsync(30_000 + 6 * 60 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    mgr.stop()
  })

  it('stop() clears the interval timer', async () => {
    vi.useFakeTimers()
    autoUpdaterMock.checkForUpdates.mockResolvedValue(undefined)
    const { UpdateManager } = await loadModule()
    const mgr = new UpdateManager({
      getMainWindow: () => null,
      getBetaChannel: () => false,
      getAutoCheck: () => true,
      isPackaged: true,
    })
    mgr.bindEvents()
    await mgr.start()
    await vi.advanceTimersByTimeAsync(30_000)
    mgr.stop()
    autoUpdaterMock.checkForUpdates.mockClear()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})
