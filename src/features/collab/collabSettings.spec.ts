import { afterEach, describe, expect, it, vi } from 'vitest'
import { onCollabSettingsChanged, setSyncServerUrl, syncServerUrl, testSyncServer } from './collabSettings'

vi.mock('@/services/portalAccount', () => ({
  loadStoredPortalAccountSession: vi.fn(async () => null),
  PORTAL_ACCOUNT_SESSION_CHANGED_EVENT: 'kition:test:portal-session-changed',
}))

afterEach(() => localStorage.clear())

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
