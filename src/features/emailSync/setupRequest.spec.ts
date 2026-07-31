import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  consumeEmailSyncSetupRequest,
  EMAIL_SYNC_SETUP_REQUEST_EVENT,
  requestEmailSyncSetup,
} from './setupRequest'

describe('email sync setup requests', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.useRealTimers()
  })

  it('preserves the full-sync intent across navigation and the setup event', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    window.addEventListener(EMAIL_SYNC_SETUP_REQUEST_EVENT, listener)

    requestEmailSyncSetup('Projects/Inbox.kitable', { runAfterSave: 'full' })
    vi.runAllTimers()

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      detail: {
        tablePath: 'Projects/Inbox.kitable',
        runAfterSave: 'full',
      },
    }))
    expect(consumeEmailSyncSetupRequest('Projects/Inbox.kitable')).toEqual({
      tablePath: 'Projects/Inbox.kitable',
      runAfterSave: 'full',
    })

    window.removeEventListener(EMAIL_SYNC_SETUP_REQUEST_EVENT, listener)
  })
})
