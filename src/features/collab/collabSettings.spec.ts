import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSyncServerUrl, onCollabSettingsChanged, setSyncServerUrl, syncServerUrl, testSyncServer } from './collabSettings'

vi.mock('@/services/portalAccount', () => ({
  loadStoredPortalAccountSession: vi.fn(async () => null),
  PORTAL_ACCOUNT_SESSION_CHANGED_EVENT: 'kition:test:portal-session-changed',
}))

afterEach(() => localStorage.clear())

describe('the build default sync server', () => {
  it('is the local server in development builds and none in release builds', () => {
    expect(defaultSyncServerUrl({ DEV: true })).toBe('ws://127.0.0.1:18300/v1/sync')
    expect(defaultSyncServerUrl({ DEV: false })).toBe('')
  })

  it('takes VITE_KITION_SYNC_URL from the build when it is set, even empty', () => {
    expect(defaultSyncServerUrl({ DEV: false, VITE_KITION_SYNC_URL: ' wss://sync.example.test/v1/sync ' })).toBe('wss://sync.example.test/v1/sync')
    expect(defaultSyncServerUrl({ DEV: true, VITE_KITION_SYNC_URL: 'wss://sync.example.test/v1/sync' })).toBe('wss://sync.example.test/v1/sync')
    expect(defaultSyncServerUrl({ DEV: true, VITE_KITION_SYNC_URL: '' })).toBe('')
  })
})

describe('the sync server setting', () => {
  it('stores the URL, turns co-editing off when empty, and goes back to the default with null', () => {
    const changed = vi.fn()
    const stop = onCollabSettingsChanged(changed)
    const fallback = syncServerUrl()
    setSyncServerUrl('  wss://sync.example.test/v1/sync  ')
    expect(syncServerUrl()).toBe('wss://sync.example.test/v1/sync')
    expect(localStorage.getItem('kition.collab.serverUrl.v1')).toBe('wss://sync.example.test/v1/sync')
    setSyncServerUrl('')
    expect(syncServerUrl()).toBe('')
    setSyncServerUrl(null)
    expect(syncServerUrl()).toBe(fallback)
    // Every change reaches this window's listeners, not only other windows'.
    expect(changed).toHaveBeenCalledTimes(3)
    stop()
    setSyncServerUrl('')
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('tests nothing for an address that is not a WebSocket URL, or without a session', async () => {
    const opened = vi.spyOn(globalThis, 'WebSocket')
    expect(await testSyncServer('https://sync.example.test')).toBe('invalid')
    expect(await testSyncServer('')).toBe('invalid')
    expect(await testSyncServer('wss://sync.example.test/v1/sync')).toBe('signed-out')
    expect(opened).not.toHaveBeenCalled()
  })
})
