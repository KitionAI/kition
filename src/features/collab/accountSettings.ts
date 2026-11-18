/**
 * This person's account settings on the sync server (kition-sync 1.9): "Sync all my documents"
 * (`syncAll`, off by default), read when the window's connection comes online and followed as any
 * of their devices changes it (`account/changed`). A server before 1.9 has none: it stays off.
 */
import { useSyncExternalStore } from 'react'
import type { AccountSettings, SyncClient } from '@/lib/sync'

let settings: AccountSettings = { syncAll: false }
const listeners = new Set<() => void>()

function set(next: AccountSettings) {
  if (next.syncAll === settings.syncAll) return
  settings = next
  for (const listener of listeners) listener()
}

/** Whether every document this person opens syncs to their devices, as last known here. */
export function syncAllDocuments() {
  return settings.syncAll
}

/** Records the settings a request answered. */
export function receiveAccountSettings(next: AccountSettings) {
  set(next)
}

/** Follows the account settings on `client`: read on every connect, then kept as they change. */
export function followAccountSettings(client: Pick<SyncClient, 'onState' | 'onAccountChanged' | 'accountSettings'>) {
  const stopChanged = client.onAccountChanged(set)
  const stopState = client.onState((state) => {
    if (state === 'online') void client.accountSettings().then(set, () => undefined)
  })
  return () => {
    stopChanged()
    stopState()
  }
}

/** Forgets them (signed out, or another server). */
export function resetAccountSettings() {
  set({ syncAll: false })
}

/** Hears "Sync all my documents" change; answers an unsubscribe. */
export function onSyncAllChanged(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSyncAllDocuments() {
  return useSyncExternalStore(onSyncAllChanged, syncAllDocuments, () => false)
}
