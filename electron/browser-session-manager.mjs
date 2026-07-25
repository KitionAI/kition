import { GenericBrowserSessionManager } from './generic-browser-session.mjs'
import { BrowserSiteRegistry } from './browser-site-registry.mjs'

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '')
}

export class BrowserSessionManager {
  constructor(desktopEnv, getMainWindow) {
    this.siteRegistry = new BrowserSiteRegistry(desktopEnv)
    void this.siteRegistry.load()
    this.providers = new Map()
    this.providers.set(
      'generic-web',
      new GenericBrowserSessionManager(desktopEnv, getMainWindow, {
        siteRegistry: this.siteRegistry,
        providerKey: 'generic-web',
      }),
    )
  }

  resolveProvider(input) {
    const provider = String(input || '').trim().toLowerCase()
    if (!provider) {
      throw new Error('browser session provider is required')
    }
    const manager = this.providers.get(provider)
    if (!manager) {
      throw new Error(`unsupported browser session provider: ${provider}`)
    }
    return {
      provider,
      manager,
    }
  }

  getProviderManager(provider) {
    return this.resolveProvider(provider).manager
  }

  async status(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    return {
      provider,
      ...(await manager.status(request)),
    }
  }

  async ensureWindow(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    return {
      provider,
      ...(await manager.ensureWindow(request)),
    }
  }

  async openHome(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.openCreatorHome === 'function') {
      return {
        provider,
        ...(await manager.openCreatorHome(request)),
      }
    }
    if (typeof manager.openHome === 'function') {
      return {
        provider,
        ...(await manager.openHome(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support opening its home page`)
  }

  async hidePanel(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.hidePanel === 'function') {
      return {
        provider,
        ...(await manager.hidePanel(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support hiding its panel`)
  }

  async setHostLayout(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.setHostLayout === 'function') {
      return {
        provider,
        ...(await manager.setHostLayout(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support host layout changes`)
  }

  async goBack(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.goBack === 'function') {
      return {
        provider,
        ...(await manager.goBack(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support back navigation`)
  }

  async goForward(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.goForward === 'function') {
      return {
        provider,
        ...(await manager.goForward(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support forward navigation`)
  }

  async reload(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.reload === 'function') {
      return {
        provider,
        ...(await manager.reload(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support reload`)
  }

  async stop(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    if (typeof manager.stop === 'function') {
      return {
        provider,
        ...(await manager.stop(request)),
      }
    }
    throw new Error(`browser session provider ${provider} does not support stop`)
  }

  async extractPageContext(request = {}) {
    const { provider, manager } = this.resolveProvider(request.provider)
    return {
      provider,
      ...(await manager.extractPageContext(request)),
    }
  }

  async listSites() {
    await this.siteRegistry.load()
    return { sites: this.siteRegistry.listSites() }
  }

  async forgetSite(request = {}) {
    await this.siteRegistry.load()
    const host = String(request.host || '').trim()
    const profileId = request.profile_id || request.profileId
    const removed = this.siteRegistry.forgetSite(host, profileId)
    for (const record of removed) {
      const manager = this.providers.get(String(record.provider || 'generic-web')) || this.providers.get('generic-web')
      await manager?.clearSiteCookies?.(record.host, record.profileId)
    }
    await this.siteRegistry.flushNow()
    return { sites: this.siteRegistry.listSites() }
  }

  async refreshLoginStatus(request = {}) {
    await this.siteRegistry.load()
    const host = normalizeHost(request.host)
    const targets = this.siteRegistry
      .listSites()
      .filter((site) => !host || site.host === host)
    for (const site of targets) {
      const manager = this.providers.get(String(site.provider || 'generic-web')) || this.providers.get('generic-web')
      if (typeof manager?.probeLoginStatus === 'function') {
        const loggedIn = await manager.probeLoginStatus(site.host, site.profileId)
        this.siteRegistry.setLoginStatus(site.host, site.profileId, loggedIn)
      }
    }
    await this.siteRegistry.flushNow()
    return { sites: this.siteRegistry.listSites() }
  }

  layoutPanels() {
    for (const manager of this.providers.values()) {
      manager.layoutPanel?.()
    }
  }

  hidePanels() {
    for (const manager of this.providers.values()) {
      manager.hidePanel?.()
    }
  }

  async shutdown() {
    for (const manager of this.providers.values()) {
      await manager.shutdown?.()
    }
    await this.siteRegistry?.flushNow?.()
  }
}
