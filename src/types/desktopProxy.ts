/**
 * Proxy configuration that the desktop shell owns and propagates to:
 *   1. The renderer web view (applied when the window opens)
 *   2. The runtime process (via `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` env vars)
 *   3. The updater's HTTP client
 *
 * The password is stored in the desktop secure store (a file under the data
 * directory, protected by OS user permissions), the rest in
 * `<data_dir>/proxy.json`. Renderer never sees the raw password — `hasPassword`
 * is a derived boolean for the form's "stored" affordance.
 */
export type DesktopProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h'

export interface DesktopProxyConfig {
  enabled: boolean
  scheme: DesktopProxyScheme
  host: string
  port: number
  username: string
  /** Comma- or whitespace-separated host suffixes that should bypass the proxy. */
  noProxy: string
}

export interface DesktopProxyState extends DesktopProxyConfig {
  /** True when a password is currently persisted in SecureStore. */
  hasPassword: boolean
}

export interface DesktopProxySavePayload extends DesktopProxyConfig {
  /**
   * Three-way semantics:
   *   - undefined: don't touch the stored password
   *   - '': delete the stored password
   *   - non-empty: replace with this value
   */
  password?: string
}

export interface DesktopProxyTestResult {
  ok: boolean
  latencyMs?: number
  message?: string
}

export function createDefaultDesktopProxyConfig(): DesktopProxyConfig {
  return {
    enabled: false,
    scheme: 'http',
    host: '',
    port: 0,
    username: '',
    noProxy: 'localhost, 127.0.0.1, ::1',
  }
}

export function createDefaultDesktopProxyState(): DesktopProxyState {
  return { ...createDefaultDesktopProxyConfig(), hasPassword: false }
}

/**
 * Build the URL form (e.g. http://user@host:port) the desktop shell and runtime
 * consume. The password is intentionally NOT part of the URL — the shell reads
 * it from the secure store right before applying it, and the runtime reads it
 * from the env var the supervisor injects. Keeping it out of the URL means we
 * never log it.
 */
export function formatProxyURLWithoutPassword(config: DesktopProxyConfig): string {
  const host = String(config.host || '').trim()
  if (!host) {
    return ''
  }
  const port = Number(config.port) || 0
  const userPart = config.username ? `${encodeURIComponent(config.username)}@` : ''
  const portPart = port > 0 ? `:${port}` : ''
  return `${config.scheme}://${userPart}${host}${portPart}`
}

export function normalizeNoProxy(value: string): string[] {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}
