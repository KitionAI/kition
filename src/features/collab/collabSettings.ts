/**
 * Co-editing settings: the sync server (`kition-sync/1`) a window connects to, and the Kition Pro
 * session it connects with. Without both, co-editing is off and Kition opens no connection: a
 * free single-user Kition works exactly as before.
 */
import { SyncClient, SyncRpcError, type SyncTransport } from '@/lib/sync'
import { loadStoredPortalAccountSession, PORTAL_ACCOUNT_SESSION_CHANGED_EVENT } from '@/services/portalAccount'

const SERVER_URL_KEY = 'kition.collab.serverUrl.v1'
/** This window changed the server URL (`storage` events only reach other windows). */
const SETTINGS_CHANGED_EVENT = 'kition:collab:settings-changed'

/** Development builds talk to a local server (kition-pro's `--memory` mode); release builds to none. */
const DEFAULT_SYNC_SERVER_URL = import.meta.env.DEV ? 'ws://127.0.0.1:18300/v1/sync' : ''

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * The sync server's WebSocket URL; empty: co-editing is off. The build's default, unless this
 * window's storage names another (`kition.collab.serverUrl.v1`; empty turns co-editing off).
 */
export function syncServerUrl(): string {
  const stored = storage()?.getItem(SERVER_URL_KEY)
  return (stored ?? DEFAULT_SYNC_SERVER_URL).trim()
}

/**
 * Sets the sync server's WebSocket URL for this window (`kition.collab.serverUrl.v1`): empty turns
 * co-editing off, `null` goes back to the build's default. Relays restart under it.
 */
export function setSyncServerUrl(url: string | null) {
  const store = storage()
  if (!store) return
  if (url === null) store.removeItem(SERVER_URL_KEY)
  else store.setItem(SERVER_URL_KEY, url.trim())
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
}

/** The Kition Pro session's token the sync server identifies this person by, or `null` when signed out. */
export async function loadCollabToken(): Promise<string | null> {
  const session = await loadStoredPortalAccountSession().catch(() => null)
  return session?.access_token || null
}

/** Hears changes to the server URL or the session; answers an unsubscribe. */
export function onCollabSettingsChanged(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SERVER_URL_KEY) listener()
  }
  window.addEventListener(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT, listener)
  window.addEventListener(SETTINGS_CHANGED_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT, listener)
    window.removeEventListener(SETTINGS_CHANGED_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * What a test connection to a sync server found: `ok` (it co-edits with this session), `no-sync`
 * (it answered, but not for co-editing with this account), `signed-out` (no session to connect
 * with), `unauthorized` (it does not know the session), `unreachable`, or `invalid` (not a
 * WebSocket URL).
 */
export type SyncServerTest = 'ok' | 'no-sync' | 'signed-out' | 'unauthorized' | 'unreachable' | 'invalid'

/** Connects to `url` once with this window's session (`sync/hello`), then disconnects. */
export async function testSyncServer(url: string, timeoutMs = 8000): Promise<SyncServerTest> {
  const target = url.trim()
  if (!/^wss?:\/\/\S+$/i.test(target)) return 'invalid'
  const token = await loadCollabToken()
  if (!token) return 'signed-out'
  const client = new SyncClient({
    createTransport: (address) => {
      const socket = new WebSocket(address)
      socket.binaryType = 'arraybuffer'
      return socket as unknown as SyncTransport
    },
    client: { name: 'Kition', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const hello = await Promise.race([
      client.connect(target, token),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      }),
    ])
    return hello.capabilities.includes('sync') ? 'ok' : 'no-sync'
  } catch (error) {
    return error instanceof SyncRpcError && error.reason === 'unauthorized' ? 'unauthorized' : 'unreachable'
  } finally {
    clearTimeout(timer)
    client.close()
  }
}
