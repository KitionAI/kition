import fs from 'node:fs/promises'
import path from 'node:path'

const fileName = 'proxy.json'
const secretKey = 'kition-desktop-proxy-password'
const supportedSchemes = new Set(['http', 'https', 'socks5', 'socks5h'])

const defaultConfig = Object.freeze({
  enabled: false,
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  noProxy: 'localhost, 127.0.0.1, ::1',
})

function clampPort(value) {
  const port = Number.parseInt(String(value || 0), 10)
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    return 0
  }
  return port
}

function normaliseScheme(value) {
  const scheme = String(value || '').trim().toLowerCase()
  return supportedSchemes.has(scheme) ? scheme : 'http'
}

function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...defaultConfig }
  }
  return {
    enabled: Boolean(raw.enabled),
    scheme: normaliseScheme(raw.scheme),
    host: String(raw.host || '').trim(),
    port: clampPort(raw.port),
    username: String(raw.username || '').trim(),
    // Keep the user's spacing for display; we only normalise on apply.
    noProxy: String(raw.noProxy || '').trim() || defaultConfig.noProxy,
  }
}

function normaliseNoProxyList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Convert the SOCKS5 / HTTP scheme + host + creds into the URL form that
 * Electron's session.setProxy `proxyRules` and Go's HTTPS_PROXY env var both
 * understand. Password is passed in separately — we keep it out of disk and
 * out of logs by encoding it only at apply time.
 */
function buildProxyURL(config, password) {
  if (!config.host) {
    return ''
  }
  let userPart = ''
  if (config.username) {
    if (password) {
      userPart = `${encodeURIComponent(config.username)}:${encodeURIComponent(password)}@`
    } else {
      userPart = `${encodeURIComponent(config.username)}@`
    }
  }
  const portPart = config.port > 0 ? `:${config.port}` : ''
  return `${config.scheme}://${userPart}${config.host}${portPart}`
}

/**
 * Electron's proxyRules grammar is colon-delimited: "scheme=proxyURL". HTTP and
 * HTTPS traffic share the same proxy server — SOCKS goes via the catch-all
 * form, which Chromium routes through SOCKS for every scheme.
 *
 * SOCKS uses `socks5://` (Chromium accepts both `socks5://` and `socks://`).
 */
function buildElectronProxyRules(config, password) {
  const url = buildProxyURL(config, password)
  if (!url) {
    return ''
  }
  if (config.scheme === 'socks5' || config.scheme === 'socks5h') {
    return url
  }
  // HTTP/HTTPS CONNECT: route both http and https traffic through it.
  return `http=${url};https=${url}`
}

/**
 * proxyBypassRules uses Chromium semantics: `<local>` for IPv4 localhost, plus
 * a comma-separated list of host/domain patterns.
 */
function buildElectronBypassRules(noProxyValue) {
  const entries = normaliseNoProxyList(noProxyValue)
  if (entries.length === 0) {
    return ''
  }
  // Chromium expects <local> to skip 127.0.0.1 / localhost / 192.168.* style
  // hosts. We add it whenever the user listed localhost-ish entries to match
  // what a Go process with NO_PROXY=localhost,127.0.0.1 would do.
  const hasLocal = entries.some((entry) =>
    entry === 'localhost' || entry === '127.0.0.1' || entry === '::1' || entry === '0.0.0.0',
  )
  const rules = hasLocal ? ['<local>', ...entries] : [...entries]
  return rules.join(',')
}

export class ProxyManager {
  /**
   * @param {object} options
   * @param {object} options.env - desktop env from resolveDesktopEnvironment
   * @param {import('./secure-store.mjs').SecureStore} options.secureStore
   * @param {() => Electron.Session | null} options.getSession - lazy because the
   *   default session is only safe to grab after app `ready`.
   * @param {() => Electron.BrowserWindow | null} [options.getMainWindow]
   */
  constructor({ env, secureStore, getSession, getMainWindow }) {
    this.env = env
    this.secureStore = secureStore
    this.getSession = getSession
    this.getMainWindow = getMainWindow || (() => null)
    this.configPath = path.join(env.data_dir, fileName)
    this.config = { ...defaultConfig }
    this.passwordCache = ''
    this.loaded = false
    this.applied = false
  }

  async load() {
    if (this.loaded) {
      return this.config
    }
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw)
      this.config = sanitizeConfig(parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('proxy config: failed to read', this.configPath, error)
      }
      this.config = { ...defaultConfig }
    }
    try {
      this.passwordCache = await this.secureStore.get(secretKey)
    } catch (error) {
      console.warn('proxy config: failed to read password', error)
      this.passwordCache = ''
    }
    this.loaded = true
    return this.config
  }

  /**
   * Return a snapshot the renderer can show. Never includes the password —
   * just a `hasPassword` flag.
   */
  state() {
    return {
      ...this.config,
      hasPassword: Boolean(this.passwordCache),
    }
  }

  /**
   * Persist a new config to disk and SecureStore. `password` is three-way:
   *   - undefined: keep existing
   *   - '': delete
   *   - string: replace
   */
  async save(payload) {
    await this.load()
    const next = sanitizeConfig(payload)
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    await fs.writeFile(this.configPath, JSON.stringify(next, null, 2), 'utf8')
    this.config = next

    if (payload && typeof payload === 'object' && payload.password !== undefined) {
      const nextPassword = String(payload.password || '')
      if (nextPassword) {
        await this.secureStore.set(secretKey, nextPassword)
        this.passwordCache = nextPassword
      } else {
        await this.secureStore.delete(secretKey)
        this.passwordCache = ''
      }
    }

    return this.state()
  }

  /**
   * Build the env-var overrides the Go subprocess should inherit. Caller
   * merges these into the spawn env (after `...process.env`) so they win.
   *
   * When proxy is disabled we explicitly write empty strings — that way a
   * previously-set process.env.HTTPS_PROXY (e.g. someone exported it in their
   * shell) gets neutered for the spawned Go API, which matches the user's
   * intent of "no proxy".
   */
  envOverrides() {
    if (!this.loaded) {
      return {}
    }
    if (!this.config.enabled || !this.config.host) {
      return {
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
        https_proxy: '',
        http_proxy: '',
        NO_PROXY: '',
        no_proxy: '',
        KITION_SMTP_PROXY: '',
      }
    }
    const url = buildProxyURL(this.config, this.passwordCache)
    const noProxy = normaliseNoProxyList(this.config.noProxy).join(',')
    return {
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      // Linux convention also reads lowercase; set both so we're not at the
      // mercy of which one a library prefers.
      https_proxy: url,
      http_proxy: url,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      // SMTP raw TCP dial doesn't use http.Transport's ProxyFromEnvironment,
      // so we pass the same URL through KITION_SMTP_PROXY which the workflow
      // SMTP sender already understands.
      KITION_SMTP_PROXY: url,
    }
  }

  /**
   * Apply the loaded config to:
   *   1. process.env (so electron-updater honors it on next check)
   *   2. session.defaultSession.setProxy (so the renderer's fetch goes through)
   *
   * Does NOT restart the Go API — caller decides whether to restart based on
   * whether the URL actually changed (and after the user confirms).
   */
  async apply() {
    await this.load()
    const env = this.envOverrides()
    // Mirror into process.env so update-manager (which spawns electron-updater
    // inside this same process) inherits the proxy automatically.
    for (const key of Object.keys(env)) {
      if (env[key]) {
        process.env[key] = env[key]
      } else {
        delete process.env[key]
      }
    }

    const session = this.getSession?.()
    if (session && typeof session.setProxy === 'function') {
      try {
        if (this.config.enabled && this.config.host) {
          await session.setProxy({
            proxyRules: buildElectronProxyRules(this.config, this.passwordCache),
            proxyBypassRules: buildElectronBypassRules(this.config.noProxy),
          })
        } else {
          await session.setProxy({ mode: 'direct' })
        }
      } catch (error) {
        console.warn('proxy config: session.setProxy failed', error)
      }
    }
    this.applied = true
  }

  /**
   * Best-effort reachability test. We open a TCP connection to the proxy
   * host:port and report latency. We deliberately do NOT try to actually
   * tunnel a request through it — that would require us to know a target,
   * and would double as a credential check. Reachability + latency is what
   * users actually want here.
   */
  /**
   * Optionally test against an ad-hoc config rather than the saved one — that
   * way the UI doesn't have to commit "save then test" round trips. We
   * deliberately ignore the password here since the test only opens a TCP
   * connection (no proxy auth handshake).
   */
  async test(override) {
    const startedAt = Date.now()
    const target = override && typeof override === 'object' ? sanitizeConfig(override) : this.config
    const host = String(target.host || '').trim()
    const port = Number(target.port) || 0
    if (!host || port <= 0) {
      return { ok: false, message: 'host or port not set' }
    }
    const net = await import('node:net')
    return await new Promise((resolve) => {
      let resolved = false
      const finish = (result) => {
        if (resolved) return
        resolved = true
        try { socket.destroy() } catch {}
        resolve(result)
      }
      const socket = net.createConnection({ host, port, timeout: 5000 })
      socket.once('connect', () => finish({ ok: true, latencyMs: Date.now() - startedAt }))
      socket.once('timeout', () => finish({ ok: false, message: `connect timeout (5s) — ${host}:${port}` }))
      socket.once('error', (error) => finish({ ok: false, message: error.message || 'connection failed' }))
    })
  }

  /**
   * Equality check the IPC handler uses to decide whether the Go API needs to
   * restart. Password change also counts — switching to a new auth secret
   * means new env that Go won't pick up without a respawn.
   */
  requiresBackendRestart(previousState, nextState, passwordChanged) {
    if (passwordChanged) return true
    const fields = ['enabled', 'scheme', 'host', 'port', 'username', 'noProxy']
    return fields.some((key) => previousState[key] !== nextState[key])
  }
}
