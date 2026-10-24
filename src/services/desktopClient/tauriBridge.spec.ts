// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { invoke } from '@tauri-apps/api/core'

import { createTauriBridge, installTauriBridge, isWindowDragTarget } from './tauriBridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))

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
    await bridge.StoreSecureValue('key', 'value')
    await bridge.UpdatesSetBetaChannel(1 as unknown as boolean)
    await bridge.ProxySave({ host: 'proxy' })
    await bridge.ListWorkspaceDocuments()

    expect(call.mock.calls).toEqual([
      ['read_workspace_document', { request: { path: 'a.md' } }],
      ['store_secure_value', { key: 'key', value: 'value' }],
      ['updates_set_beta_channel', { enabled: true }],
      ['proxy_save', { payload: { host: 'proxy' } }],
      ['list_workspace_documents', undefined],
    ])
    expect(bridge.shell).toBe('tauri')
    expect(bridge.backendOrigin).toBe(globals.backendOrigin)
  })

  it('maps every bridge method to its native command', async () => {
    const call = vi.fn().mockResolvedValue(null)
    const bridge = createTauriBridge(globals, call)
    const requestCommands = {
      SaveBinaryFile: 'save_binary_file',
      SavePdfFile: 'save_pdf_file',
      CopyImage: 'copy_image',
      SubmitFeedback: 'submit_feedback',
      ReadWorkspaceImage: 'read_workspace_image',
      ReadWorkspaceDocument: 'read_workspace_document',
      StatWorkspaceDocument: 'stat_workspace_document',
      WriteWorkspaceDocument: 'write_workspace_document',
      CreateWorkspaceDocument: 'create_workspace_document',
      ReadDocumentStore: 'read_document_store',
      WriteDocumentStore: 'write_document_store',
      DeleteDocumentStore: 'delete_document_store',
      ReadDocumentIndex: 'read_document_index',
      WriteDocumentIndex: 'write_document_index',
      ReadDocumentHistory: 'read_document_history',
      RecordDocumentCheckpoint: 'record_document_checkpoint',
      ReadDocumentCheckpoint: 'read_document_checkpoint',
      CreateWorkspaceFolder: 'create_workspace_folder',
      MoveWorkspaceDocument: 'move_workspace_document',
      MoveWorkspaceFolder: 'move_workspace_folder',
      DeleteWorkspaceDocument: 'delete_workspace_document',
      DeleteWorkspaceFolder: 'delete_workspace_folder',
      OpenWorkspaceFile: 'open_workspace_file',
      ImportWorkspaceFile: 'import_workspace_file',
      RevealWorkspaceFolder: 'reveal_workspace_folder',
      SetWorkspaceFolder: 'set_workspace_folder',
      AddVault: 'add_vault',
      RemoveVault: 'remove_vault',
      RenameVault: 'rename_vault',
      SetActiveVault: 'set_active_vault',
      ChooseDirectory: 'choose_directory',
      OpenWorkspaceWindow: 'open_workspace_window',
      ChooseAgentAnalysisDirectory: 'choose_agent_analysis_directory',
    } as const
    const plainCommands = {
      DesktopInfo: 'desktop_info',
      BackendStatus: 'backend_status',
      RetryBackendStart: 'retry_backend_start',
      BootstrapInitialize: 'bootstrap_initialize',
      BootstrapCreateAttestation: 'bootstrap_create_attestation',
      BootstrapStatus: 'bootstrap_status',
      ListWorkspaceDocuments: 'list_workspace_documents',
      ChooseFilesToImport: 'choose_files_to_import',
      ChooseWorkspaceFolder: 'choose_workspace_folder',
      ListVaults: 'list_vaults',
      DocumentStoreStatus: 'document_store_status',
      UpdatesGetState: 'updates_get_state',
      UpdatesCheck: 'updates_check',
      UpdatesDownload: 'updates_download',
      UpdatesInstall: 'updates_install',
      ProxyGet: 'proxy_get',
      ProxyRestartBackend: 'proxy_restart_backend',
    } as const

    for (const [method, command] of Object.entries(requestCommands)) {
      call.mockClear()
      await (bridge[method as keyof typeof requestCommands] as (payload?: unknown) => Promise<unknown>)()
      expect(call, method).toHaveBeenCalledWith(command, { request: null })
    }
    for (const [method, command] of Object.entries(plainCommands)) {
      call.mockClear()
      await (bridge[method as keyof typeof plainCommands] as () => Promise<unknown>)()
      expect(call, method).toHaveBeenCalledWith(command, undefined)
    }

    call.mockClear()
    await bridge.OpenExternalURL('https://kition.ai')
    await bridge.BrowserOpenURL('https://kition.ai/docs')
    await bridge.ShowNotification('Saved', 'All changes saved')
    await bridge.WindowAction('minimize')
    await bridge.OpenRuntimePath('logs')
    await bridge.ReadSecureValue('token')
    await bridge.DeleteSecureValue('token')
    await bridge.UpdatesSetAutoCheck(false)
    await bridge.ProxyTest()
    expect(call.mock.calls).toEqual([
      ['open_external_url', { url: 'https://kition.ai' }],
      ['open_external_url', { url: 'https://kition.ai/docs' }],
      ['show_notification', { title: 'Saved', message: 'All changes saved' }],
      ['window_action', { action: 'minimize' }],
      ['open_runtime_path', { kind: 'logs' }],
      ['read_secure_value', { key: 'token' }],
      ['delete_secure_value', { key: 'token' }],
      ['updates_set_auto_check', { enabled: false }],
      ['proxy_test', { payload: null }],
    ])
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

  it('toggles devtools with F12 unless another handler took the key', () => {
    window.__KITION_DESKTOP__ = globals
    installTauriBridge()
    const windowAction = vi.mocked(invoke)
    windowAction.mockClear()

    const handled = new KeyboardEvent('keydown', { key: 'F12', cancelable: true })
    handled.preventDefault()
    document.dispatchEvent(handled)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', cancelable: true }))
    expect(windowAction).not.toHaveBeenCalled()

    const press = new KeyboardEvent('keydown', { key: 'F12', cancelable: true })
    document.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect(windowAction).toHaveBeenCalledWith('window_action', { action: 'toggle-devtools' })
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
