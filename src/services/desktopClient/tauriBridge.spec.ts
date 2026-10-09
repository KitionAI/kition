// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTauriBridge, installTauriBridge, isWindowDragTarget } from './tauriBridge'

const globals = { shell: 'tauri' as const, backendOrigin: 'http://127.0.0.1:18101', platform: 'darwin' }

afterEach(() => {
  delete window.kitionDesktop
  delete window.__KITION_DESKTOP__
  document.body.innerHTML = ''
})

describe('createTauriBridge', () => {
  it('maps bridge methods to native commands with the renderer request', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    const bridge = createTauriBridge(globals, call)

    await bridge.ReadWorkspaceDocument({ path: 'a.md' })
    await bridge.SaveTextFile('Export', 'notes.md', '# Notes')
    await bridge.StoreSecureValue('key', 'value')
    await bridge.UpdatesSetBetaChannel(1 as unknown as boolean)
    await bridge.ProxySave({ host: 'proxy' })
    await bridge.ListWorkspaceDocuments()

    expect(call.mock.calls).toEqual([
      ['read_workspace_document', { request: { path: 'a.md' } }],
      ['save_text_file', { dialogTitle: 'Export', defaultFilename: 'notes.md', content: '# Notes' }],
      ['store_secure_value', { key: 'key', value: 'value' }],
      ['updates_set_beta_channel', { enabled: true }],
      ['proxy_save', { payload: { host: 'proxy' } }],
      ['list_workspace_documents', undefined],
    ])
    expect(bridge.shell).toBe('tauri')
    expect(bridge.backendOrigin).toBe(globals.backendOrigin)
  })

  it('turns native error strings into errors the renderer can match', async () => {
    const bridge = createTauriBridge(globals, vi.fn().mockRejectedValue('DESIGN_SAVE_CONFLICT'))

    await expect(bridge.WriteWorkspaceDocument({ path: 'a.kidesign' })).rejects.toThrow('DESIGN_SAVE_CONFLICT')
  })

  it('delivers event payloads and stops after unsubscribe, even before listen resolves', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined
    const stop = vi.fn()
    let resolveListen: (value: () => void) => void = () => {}
    const subscribe = vi.fn((_event: string, next: (event: { payload: unknown }) => void) => {
      handler = next
      return new Promise<() => void>((resolve) => { resolveListen = resolve })
    })
    const bridge = createTauriBridge(globals, vi.fn(), subscribe)
    const received: unknown[] = []

    const unsubscribe = bridge.EventsOn(bridge.updatesEvent, (payload) => received.push(payload))
    handler?.({ payload: { phase: 'checking' } })
    unsubscribe()
    resolveListen(stop)
    await Promise.resolve()

    expect(subscribe).toHaveBeenCalledWith('desktop:updates:state', expect.any(Function))
    expect(received).toEqual([{ phase: 'checking' }])
    expect(stop).toHaveBeenCalled()
  })
})

describe('installTauriBridge', () => {
  it('only installs inside the Tauri shell', () => {
    installTauriBridge()
    expect(window.kitionDesktop).toBeUndefined()

    window.__KITION_DESKTOP__ = globals
    installTauriBridge()
    expect(window.kitionDesktop?.shell).toBe('tauri')
  })
})

describe('isWindowDragTarget', () => {
  it('drags from macOS title regions but not from their controls', () => {
    document.body.innerHTML = `
      <div class="app-shell" data-desktop-platform="darwin">
        <header class="app-topbar"><span id="title">Title</span><button id="action">Go</button></header>
        <main><span id="body">Body</span></main>
      </div>
      <div class="app-shell" data-desktop-platform="win32">
        <header class="app-topbar"><span id="windows">Title</span></header>
      </div>`

    expect(isWindowDragTarget(document.getElementById('title'))).toBe(true)
    expect(isWindowDragTarget(document.getElementById('action'))).toBe(false)
    expect(isWindowDragTarget(document.getElementById('body'))).toBe(false)
    expect(isWindowDragTarget(document.getElementById('windows'))).toBe(false)
    expect(isWindowDragTarget(null)).toBe(false)
  })
})
