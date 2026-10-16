/**
 * Co-editing settings: the sync server (`kition-sync/1`) a window connects to, and the Kition Pro
 * session it connects with. Without both, co-editing is off and Kition opens no connection: a
 * free single-user Kition works exactly as before.
 */
import { loadStoredPortalAccountSession, PORTAL_ACCOUNT_SESSION_CHANGED_EVENT } from '@/services/portalAccount'

const SERVER_URL_KEY = 'kition.collab.serverUrl.v1'

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
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PORTAL_ACCOUNT_SESSION_CHANGED_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}
