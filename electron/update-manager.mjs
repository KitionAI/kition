import pkg from 'electron-updater'
import log from 'electron-log/node.js'
import { classifyUpdateError } from './classify-update-error.mjs'

const { autoUpdater } = pkg

autoUpdater.logger = log
log.transports.file.level = 'info'
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

export const DESKTOP_UPDATES_EVENT = 'desktop:updates:state'

export class UpdateManager {
  constructor({ getMainWindow, getBetaChannel, getAutoCheck, isPackaged }) {
    this.getMainWindow = getMainWindow
    this.getBetaChannel = getBetaChannel
    this.getAutoCheck = getAutoCheck
    this.isPackaged = Boolean(isPackaged)
    this.state = { phase: 'idle' }
    this.timer = null
    this.lastBroadcastAt = 0
  }

  set(next) {
    this.state = next
    const win = this.getMainWindow()
    if (!win || win.isDestroyed?.() || !win.webContents) {
      return
    }
    win.webContents.send(DESKTOP_UPDATES_EVENT, this.state)
  }

  bindEvents() {
    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) => this.set({
      phase: 'available',
      version: info?.version,
      releaseNotes: info?.releaseNotes,
      releaseDate: info?.releaseDate,
    }))
    autoUpdater.on('update-not-available', (info) => this.set({
      phase: 'up-to-date',
      currentVersion: info?.version,
    }))
    autoUpdater.on('download-progress', (progress) => this.setProgress({
      phase: 'downloading',
      percent: progress?.percent ?? 0,
      transferred: progress?.transferred ?? 0,
      total: progress?.total ?? 0,
      bytesPerSecond: progress?.bytesPerSecond ?? 0,
    }))
    autoUpdater.on('update-downloaded', (info) => this.set({
      phase: 'downloaded',
      version: info?.version,
    }))
    autoUpdater.on('error', (err) => {
      const phaseAtError = this.state.phase
      const { kind, message } = classifyUpdateError(err)
      this.set({ phase: 'error', message, errorKind: kind, phaseAtError })
    })
  }

  setProgress(next) {
    this.state = next                                    // keep memory state fresh
    const now = Date.now()
    if (now - this.lastBroadcastAt < 250) return         // 250ms throttle
    this.lastBroadcastAt = now
    const win = this.getMainWindow()
    if (!win || win.isDestroyed?.() || !win.webContents) return
    win.webContents.send(DESKTOP_UPDATES_EVENT, this.state)
  }

  async check() {
    if (!this.isPackaged) {
      this.set({ phase: 'unsupported', reason: 'dev build' })
      return this.state
    }
    if (['checking', 'downloading', 'downloaded'].includes(this.state.phase)) {
      return this.state
    }
    autoUpdater.allowPrerelease = Boolean(this.getBetaChannel())
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // electron-updater emits 'error' separately; swallow the rejection here
    }
    return this.state
  }

  async download() {
    if (this.state.phase !== 'available') {
      throw new Error('no update to download')
    }
    this.set({
      phase: 'downloading',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    })
    await autoUpdater.downloadUpdate()
  }

  quitAndInstall() {
    if (this.state.phase !== 'downloaded') {
      throw new Error('no downloaded update')
    }
    autoUpdater.quitAndInstall(false, true)
  }

  async setBetaChannel(enabled) {
    const next = Boolean(enabled)
    if (autoUpdater.allowPrerelease === next) return
    autoUpdater.allowPrerelease = next
    await this.check()
  }

  async start() {
    if (!this.isPackaged) {
      this.set({ phase: 'unsupported', reason: 'dev build' })
      return
    }
    if (!this.getAutoCheck()) {
      return
    }
    setTimeout(() => { void this.check() }, 30_000)
    this.timer = setInterval(() => {
      if (!this.getAutoCheck()) return
      void this.check()
    }, 6 * 60 * 60 * 1000)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
