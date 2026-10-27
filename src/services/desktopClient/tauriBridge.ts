/**
 * Installs `window.kitionDesktop` inside the Tauri desktop shell. Every bridge
 * method maps to one native command, so the rest of the renderer keeps using
 * the same bridge contract it always has.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

const DESKTOP_MENU_EVENT = 'desktop:menu'
const DESKTOP_UPDATES_EVENT = 'desktop:updates:state'
const DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT = 'desktop:document:external-change'
const DESKTOP_DOCUMENT_STORE_ACCESS_EVENT = 'desktop:document-store:access'

/** Values the native shell injects before any renderer module runs. */
export type TauriDesktopGlobals = {
  shell: 'tauri'
  backendOrigin: string
  platform: string
}

type Invoke = (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>
type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>

declare global {
  interface Window {
    __KITION_DESKTOP__?: TauriDesktopGlobals
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

/** Builds the bridge object; `call` and `subscribe` are injectable for tests. */
export function createTauriBridge(
  globals: TauriDesktopGlobals,
  call: Invoke = invoke,
  subscribe: Listen = listen,
) {
  // Results are typed by the bridge contract in bridge.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const command = <T = any>(name: string, args?: Record<string, unknown>) =>
    call(name, args).then((value) => value as T, (error: unknown) => { throw asError(error) })
  const request = (name: string) => (payload?: unknown) => command(name, { request: payload ?? null })

  return {
    shell: 'tauri' as const,
    backendOrigin: globals.backendOrigin,
    menuEvent: DESKTOP_MENU_EVENT,
    updatesEvent: DESKTOP_UPDATES_EVENT,
    documentExternalChangeEvent: DESKTOP_DOCUMENT_EXTERNAL_CHANGE_EVENT,
    documentStoreAccessEvent: DESKTOP_DOCUMENT_STORE_ACCESS_EVENT,
    DesktopInfo: () => command('desktop_info'),
    BackendStatus: () => command('backend_status'),
    RetryBackendStart: () => command('retry_backend_start'),
    OpenExternalURL: (url: string) => command<void>('open_external_url', { url: String(url ?? '') }),
    BrowserOpenURL: (url: string) => command<void>('open_external_url', { url: String(url ?? '') }),
    ShowNotification: (title: string, message: string) =>
      command<void>('show_notification', { title: String(title ?? ''), message: String(message ?? '') }),
    WindowAction: (action: string) => command<void>('window_action', { action: String(action ?? '') }),
    OpenRuntimePath: (kind: string) => command<void>('open_runtime_path', { kind: String(kind ?? '') }),
    BootstrapInitialize: () => command('bootstrap_initialize'),
    BootstrapCreateAttestation: () => command('bootstrap_create_attestation'),
    BootstrapStatus: () => command('bootstrap_status'),
    SaveBinaryFile: request('save_binary_file'),
    SavePdfFile: request('save_pdf_file'),
    CopyImage: request('copy_image'),
    // Only macOS's shell prints a PDF (PDFKit); elsewhere the bridge has no printing.
    ...(globals.platform === 'darwin'
      ? {
          PrintPdf: (bytes: Uint8Array, title: string) =>
            call('print_pdf', bytes, { headers: { 'kition-print-title': encodeURIComponent(title) } }).then((printed) => printed === true, (error: unknown) => { throw asError(error) }),
        }
      : {}),
    SubmitFeedback: request('submit_feedback'),
    ListWorkspaceDocuments: () => command('list_workspace_documents'),
    ReadWorkspaceImage: request('read_workspace_image'),
    ReadWorkspaceDocument: request('read_workspace_document'),
    StatWorkspaceDocument: request('stat_workspace_document'),
    WriteWorkspaceDocument: request('write_workspace_document'),
    CreateWorkspaceDocument: request('create_workspace_document'),
    ReadDocumentStore: request('read_document_store'),
    WriteDocumentStore: request('write_document_store'),
    DeleteDocumentStore: request('delete_document_store'),
    ReadDocumentIndex: request('read_document_index'),
    WriteDocumentIndex: request('write_document_index'),
    ReadDocumentHistory: request('read_document_history'),
    RecordDocumentCheckpoint: request('record_document_checkpoint'),
    ReadDocumentCheckpoint: request('read_document_checkpoint'),
    DocumentStoreStatus: () => command('document_store_status'),
    CreateWorkspaceFolder: request('create_workspace_folder'),
    MoveWorkspaceDocument: request('move_workspace_document'),
    MoveWorkspaceFolder: request('move_workspace_folder'),
    DeleteWorkspaceDocument: request('delete_workspace_document'),
    DeleteWorkspaceFolder: request('delete_workspace_folder'),
    OpenWorkspaceFile: request('open_workspace_file'),
    ImportWorkspaceFile: request('import_workspace_file'),
    ChooseFilesToImport: () => command('choose_files_to_import'),
    RevealWorkspaceFolder: request('reveal_workspace_folder'),
    ChooseWorkspaceFolder: () => command('choose_workspace_folder'),
    SetWorkspaceFolder: request('set_workspace_folder'),
    ListVaults: () => command('list_vaults'),
    AddVault: request('add_vault'),
    RemoveVault: request('remove_vault'),
    RenameVault: request('rename_vault'),
    SetActiveVault: request('set_active_vault'),
    ChooseDirectory: request('choose_directory'),
    OpenWorkspaceWindow: request('open_workspace_window'),
    ChooseAgentAnalysisDirectory: request('choose_agent_analysis_directory'),
    StoreSecureValue: (key: string, value: string) =>
      command<void>('store_secure_value', { key: String(key ?? ''), value: String(value ?? '') }),
    ReadSecureValue: (key: string) => command<string>('read_secure_value', { key: String(key ?? '') }),
    DeleteSecureValue: (key: string) => command<void>('delete_secure_value', { key: String(key ?? '') }),
    UpdatesGetState: () => command('updates_get_state'),
    UpdatesCheck: () => command('updates_check'),
    UpdatesDownload: () => command<void>('updates_download'),
    UpdatesInstall: () => command<void>('updates_install'),
    UpdatesSetBetaChannel: (enabled: boolean) => command<void>('updates_set_beta_channel', { enabled: Boolean(enabled) }),
    UpdatesSetAutoCheck: (enabled: boolean) => command<void>('updates_set_auto_check', { enabled: Boolean(enabled) }),
    ProxyGet: () => command('proxy_get'),
    ProxySave: (payload: unknown) => command('proxy_save', { payload: payload ?? null }),
    ProxyTest: (payload?: unknown) => command('proxy_test', { payload: payload ?? null }),
    ProxyRestartBackend: () => command('proxy_restart_backend'),
    EventsOn: (eventName: string, callback: (payload: any) => void) => {
      let disposed = false
      let unlisten: (() => void) | null = null
      void subscribe(eventName, (event) => callback(event.payload)).then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      return () => {
        disposed = true
        unlisten?.()
      }
    },
  }
}

const DRAG_REGION_SELECTOR = '.app-topbar, .workspace-sidebar-header, .document-sidebar-titlebar'
const NO_DRAG_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="tab"]',
  '.document-tab',
  '.workspace-agent-tab',
  '[data-window-drag-exclude="true"]',
].join(', ')

/**
 * Whether a mouse down on `target` should move the window. The macOS title
 * bar overlays the top bar and sidebar headers, which act as drag handles
 * except over their controls.
 */
export function isWindowDragTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const region = target.closest(DRAG_REGION_SELECTOR)
  if (!region || !region.closest('.app-shell[data-desktop-platform="darwin"]')) return false
  const control = target.closest(NO_DRAG_SELECTOR)
  return !control || !region.contains(control)
}

function installWindowDragging() {
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !isWindowDragTarget(event.target)) return
    const window = getCurrentWindow()
    if (event.detail === 2) void window.toggleMaximize()
    else void window.startDragging()
  })
}

function installDevtoolsShortcut(bridge: ReturnType<typeof createTauriBridge>) {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F12' || event.defaultPrevented) return
    event.preventDefault()
    void bridge.WindowAction('toggle-devtools')
  })
}

export function installTauriBridge() {
  if (typeof window === 'undefined' || window.kitionDesktop) return
  const globals = window.__KITION_DESKTOP__
  if (globals?.shell !== 'tauri') return
  const bridge = createTauriBridge(globals)
  window.kitionDesktop = bridge
  installWindowDragging()
  installDevtoolsShortcut(bridge)
}

installTauriBridge()
