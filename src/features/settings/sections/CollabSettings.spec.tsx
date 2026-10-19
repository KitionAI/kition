import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/collab/public', () => {
  let url = 'ws://127.0.0.1:18300/v1/sync'
  return {
    syncServerUrl: vi.fn(() => url),
    setSyncServerUrl: vi.fn((next: string | null) => {
      url = next === null ? 'ws://127.0.0.1:18300/v1/sync' : next.trim()
    }),
    testSyncServer: vi.fn(async () => 'ok'),
    useCollabConnectionState: () => 'off',
    useSyncAllDocuments: () => false,
    setSyncAllDocuments: vi.fn(async () => undefined),
    refreshAccountSettings: vi.fn(async () => undefined),
    requestSyncedDocuments: vi.fn(),
  }
})

import * as collab from '@/features/collab/public'
import { CollabSettings } from './CollabSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(CollabSettings))
  })
}

function field() {
  return container.querySelector<HTMLInputElement>('[data-testid="collab-server-url"]')!
}

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(testId: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
    await Promise.resolve()
  })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container?.remove()
  vi.clearAllMocks()
})

describe('CollabSettings', () => {
  it('shows the server URL, saves a new one, and connects only when tested', async () => {
    await mount()
    expect(field().value).toBe('ws://127.0.0.1:18300/v1/sync')
    const save = () => container.querySelector<HTMLButtonElement>('[data-testid="collab-server-save"]')!
    expect(save().disabled).toBe(true)
    expect(collab.testSyncServer).not.toHaveBeenCalled()

    await type('wss://sync.example.test/v1/sync')
    expect(save().disabled).toBe(false)
    await click('collab-server-save')
    expect(collab.setSyncServerUrl).toHaveBeenCalledWith('wss://sync.example.test/v1/sync')
    expect(save().disabled).toBe(true)

    await click('collab-server-test')
    expect(collab.testSyncServer).toHaveBeenCalledWith('wss://sync.example.test/v1/sync')
    expect(container.querySelector('[data-testid="collab-server-test"]')?.getAttribute('data-result')).toBe('ok')
  })

  it('reads "Sync all my documents" from the server, turns it on, and shows the synced documents', async () => {
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(collab.refreshAccountSettings).toHaveBeenCalled()
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="collab-sync-all"]')!
    expect(toggle.disabled).toBe(false)
    await click('collab-sync-all')
    expect(collab.setSyncAllDocuments).toHaveBeenCalledWith(true)
    await click('collab-synced-show')
    expect(collab.requestSyncedDocuments).toHaveBeenCalled()
  })

  it('turns co-editing off with an empty URL', async () => {
    await mount()
    await type('')
    await click('collab-server-save')
    expect(collab.setSyncServerUrl).toHaveBeenCalledWith('')
    expect(container.querySelector('[data-testid="collab-settings-status"]')?.getAttribute('data-state')).toBe('off')
  })
})
