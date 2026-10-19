/**
 * The window's one connection to the sync server: a `SyncClient` made on first use, and only when
 * there is a server URL and a Kition Pro session (`collabSettings.ts`). Its connection state is a
 * store the indicators read.
 */
import { useSyncExternalStore } from 'react'
import { SyncClient, type ConnectionState, type SyncTransport } from '@/lib/sync'
import { setCommentIdentity } from '@/services/documentComments'
import { loadCollabToken, syncServerUrl } from './collabSettings'

/** `off`: co-editing is not set up in this window (no server or no session). */
export type CollabConnectionState = ConnectionState | 'off'

/** Why a co-editing action cannot run: not set up, or the server cannot be reached. */
export class CollabUnavailableError extends Error {
  constructor(readonly reason: 'off' | 'unreachable') {
    super(reason === 'off' ? 'co-editing needs a Kition Pro session and a sync server' : 'the sync server cannot be reached')
  }
}

type Connection = { client: SyncClient; url: string; token: string }

let current: Connection | null = null
let state: CollabConnectionState = 'off'
const listeners = new Set<() => void>()

function setState(next: CollabConnectionState) {
  if (state === next) return
  state = next
  for (const listener of listeners) listener()
}

function webSocketTransport(url: string): SyncTransport {
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  return socket as unknown as SyncTransport
}

/** Whether this window may co-edit: a sync server URL and a Kition Pro session. */
export async function collabConfigured() {
  return Boolean(syncServerUrl()) && Boolean(await loadCollabToken())
}

let pending: Promise<SyncClient | null> | null = null

/** The window's sync client, connecting it on first use; `null` when co-editing is off. */
export function syncClient(): Promise<SyncClient | null> {
  pending ??= openSyncClient().finally(() => {
    pending = null
  })
  return pending
}

async function openSyncClient(): Promise<SyncClient | null> {
  const url = syncServerUrl()
  if (!url) return null
  const token = await loadCollabToken()
  if (!token) return null
  if (current && current.url === url && current.token === token) return current.client
  closeSyncClient()
  const client = new SyncClient({ createTransport: webSocketTransport, client: { name: 'Kition', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' } })
  client.onState(setState)
  // Who this person comments as, also once the document is no longer co-edited (rule M23).
  client.onState((next) => {
    if (next === 'online' && client.principal) setCommentIdentity(client.principal)
  })
  current = { client, url, token }
  // A first attempt that fails keeps retrying with backoff; the state store follows it.
  client.connect(url, token).catch(() => undefined)
  return client
}

/** The sync client, online, for an action the person started; throws `CollabUnavailableError` otherwise. */
export async function onlineSyncClient(timeoutMs = 10_000): Promise<SyncClient> {
  const client = await syncClient()
  if (!client) throw new CollabUnavailableError('off')
  if (client.state === 'online') return client
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new CollabUnavailableError('unreachable'))
    }, timeoutMs)
    const off = client.onState((next) => {
      if (next !== 'online') return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
  return client
}

/** Closes the window's connection (the session or the server changed). */
export function closeSyncClient() {
  current?.client.close()
  current = null
  setState('off')
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCollabConnectionState(): CollabConnectionState {
  return useSyncExternalStore(subscribe, () => state, () => 'off')
}
