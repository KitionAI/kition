import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountSettings, ConnectionState } from '@/lib/sync'
import { followAccountSettings, onSyncAllChanged, resetAccountSettings, syncAllDocuments } from './accountSettings'

function fakeClient(settings: AccountSettings) {
  const state = new Set<(state: ConnectionState) => void>()
  const changed = new Set<(settings: AccountSettings) => void>()
  return {
    accountSettings: vi.fn(async () => settings),
    onState: (listener: (state: ConnectionState) => void) => {
      state.add(listener)
      return () => state.delete(listener)
    },
    onAccountChanged: (listener: (settings: AccountSettings) => void) => {
      changed.add(listener)
      return () => changed.delete(listener)
    },
    go: (next: ConnectionState) => state.forEach((listener) => listener(next)),
    change: (next: AccountSettings) => changed.forEach((listener) => listener(next)),
  }
}

afterEach(() => resetAccountSettings())

describe('account settings', () => {
  it('is off until the server says otherwise, reads it on connect, and follows changes from other devices', async () => {
    expect(syncAllDocuments()).toBe(false)
    const client = fakeClient({ syncAll: true })
    const heard = vi.fn()
    const stopListening = onSyncAllChanged(heard)
    const stop = followAccountSettings(client)
    client.go('online')
    await vi.waitFor(() => expect(syncAllDocuments()).toBe(true))
    expect(heard).toHaveBeenCalledTimes(1)
    client.change({ syncAll: false })
    expect(syncAllDocuments()).toBe(false)
    stop()
    client.change({ syncAll: true })
    expect(syncAllDocuments()).toBe(false)
    stopListening()
  })

  it('stays off when the server predates the setting', async () => {
    const client = fakeClient({ syncAll: false })
    client.accountSettings.mockRejectedValueOnce(new Error('method not found'))
    followAccountSettings(client)
    client.go('online')
    await Promise.resolve()
    expect(syncAllDocuments()).toBe(false)
  })
})
