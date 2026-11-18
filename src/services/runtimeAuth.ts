/**
 * This launch's API token (contracts/runtime/transport.schema.json). The runtime refuses every
 * request without it, because it can run commands as the person: the desktop shell makes the
 * token, hands it to this window's main frame only, and this module takes it as the renderer
 * loads and removes it from `window`, so nothing that runs later finds it there.
 *
 * Requests to the runtime carry it in the `Kition-Token` header (`runtimeFetch`, and the request
 * client in `src/api/request.ts`). URLs that cannot carry a header (an `<img>`, `EventSource`, a
 * kit engine's lent reads) are signed with it instead (`signRuntimePath`): a signature for one
 * file, or one folder, that expires; never the token itself. In the web build there is no token;
 * the development server adds it for the runtime it proxies.
 *
 * Kit frames are same-origin with this page until kit frame isolation's second phase (W1-30):
 * a hostile kit page can still reach this module's requests through `window.parent`. The token is
 * kept off `window` and out of every URL a kit is given so that phase leaves nothing behind.
 */
import type { TransportTokenHeader } from '@/api/generated/transport'
import { hmacSha256Hex } from '@/lib/hmacSha256'
import { getDesktopBridge } from './desktopClient/bridge'

/** The request header that carries the token. */
export const RUNTIME_TOKEN_HEADER: TransportTokenHeader = 'Kition-Token'
/** Where signed URL paths start. */
const SIGNED_ROOT = '/_signed/'
/** The window property the desktop shell's bootstrap script defines. */
const TOKEN_PROPERTY = '__KITION_API_TOKEN__'
const HOUR_SECONDS = 3600
/**
 * Signed URLs expire on an hour boundary 24 to 25 hours ahead, so a URL built twice within an
 * hour is the same string (an `<img>` does not reload) and a kit editor's lent root outlives a
 * working day.
 */
const SIGNED_HOURS = 25

function takeToken() {
  if (typeof window === 'undefined') return ''
  const target = window as unknown as Record<string, unknown>
  const value = target[TOKEN_PROPERTY]
  try {
    delete target[TOKEN_PROPERTY]
  } catch {
    // A property that cannot be deleted stays; the renderer still reads it only once.
  }
  return typeof value === 'string' ? value : ''
}

let token = takeToken()

/** Whether this window holds a token (the desktop app). */
export function hasRuntimeToken() {
  return token !== ''
}

/** Tests only: installs `value` as this window's token. */
export function setRuntimeTokenForTests(value: string) {
  token = value
}

/** The desktop runtime's origin when the shell names none. */
export const DESKTOP_BACKEND_ORIGIN_FALLBACK = 'http://127.0.0.1:18101'

function runtimeOrigin() {
  const bridge = getDesktopBridge()
  if (bridge) {
    try {
      return new URL(bridge.backendOrigin || DESKTOP_BACKEND_ORIGIN_FALLBACK).origin
    } catch {
      return ''
    }
  }
  return typeof window === 'undefined' ? '' : window.location.origin
}

/** Whether `url` is addressed to the runtime, the only place the token may go. */
export function isRuntimeURL(url: string) {
  if (typeof window === 'undefined') return false
  const origin = runtimeOrigin()
  if (!origin) return false
  try {
    return new URL(url, window.location.href).origin === origin
  } catch {
    return false
  }
}

/** The token header for a request to `url`: present only when `url` is the runtime's. */
export function runtimeTokenHeaders(url: string): Record<string, string> {
  return token && isRuntimeURL(url) ? { [RUNTIME_TOKEN_HEADER]: token } : {}
}

/** `fetch` for the runtime's routes: it adds the token when `url` is the runtime's. */
export function runtimeFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(runtimeTokenHeaders(url))) headers.set(name, value)
  return fetch(url, { ...init, headers })
}

function signedExpiry(nowMs: number) {
  return (Math.floor(nowMs / 1000 / HOUR_SECONDS) + SIGNED_HOURS) * HOUR_SECONDS
}

/**
 * `path` (from `/`, percent-encoded, with any query or fragment) as a signed path on the
 * runtime, for `GET` and `HEAD`. `scope: 'file'` signs the path itself; `scope: 'folder'` signs
 * `path`, which ends in `/`, and lets the reader append the rest (a kit engine's lent root).
 * Without a token (the web build) the path is returned as it is.
 */
export function signRuntimePath(path: string, { scope = 'file', now = Date.now() }: { scope?: 'file' | 'folder'; now?: number } = {}) {
  if (!token || !path.startsWith('/') || path.startsWith(SIGNED_ROOT)) return path
  const match = /^([^?#]*)(.*)$/.exec(path)
  const pathname = match?.[1] ?? path
  const suffix = match?.[2] ?? ''
  if (scope === 'folder' && !pathname.endsWith('/')) return path
  const expires = signedExpiry(now)
  const signature = hmacSha256Hex(token, `${expires}\n${pathname}`)
  return `${SIGNED_ROOT}${expires}.${pathname.length}.${signature}${pathname}${suffix}`
}

/** An absolute runtime URL (`<origin>/<path>`) signed like `signRuntimePath`; other URLs as they are. */
export function signRuntimeURL(url: string, options?: Parameters<typeof signRuntimePath>[1]) {
  if (!token || !isRuntimeURL(url)) return url
  const parsed = new URL(url, window.location.href)
  return `${parsed.origin}${signRuntimePath(`${parsed.pathname}${parsed.search}${parsed.hash}`, options)}`
}
