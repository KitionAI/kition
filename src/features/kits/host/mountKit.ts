// Copied from kition-sdk packages/kit-host/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The host's side of the Kit UI protocol (docs/ui-protocol.md): mount an embedded kit UI in an
 * iframe, hand it its port, initialize it with the document, theme, and locale, and serve its
 * file calls with the host's own handlers. Framework-free.
 */
import {
  KIT_UI_PROTOCOL,
  KitPeer,
  KitRpcError,
  type AiRunResult,
  type AiStep,
  type DocumentState,
  type HostPeer,
  type InitializeResult,
  type KitDocumentInit,
  type KitNotifications,
  type KitTheme,
  type KitToHost,
} from './protocol'

export { KIT_UI_PROTOCOL, KitRpcError }
export type { DocumentState, InitializeResult, KitDocumentInit, KitTheme }

type Params<M extends keyof KitToHost> = KitToHost[M][0]
type Result<M extends keyof KitToHost> = KitToHost[M][1] | Promise<KitToHost[M][1]>

/** What the host does for the kit. Every path is workspace-relative; the host checks it (UI-H2). */
export type KitHostHandlers = {
  read: (params: Params<'host/read'>) => Result<'host/read'>
  stamp: (params: Params<'host/stamp'>) => Result<'host/stamp'>
  write: (params: Params<'host/write'>) => Result<'host/write'>
  pick?: (params: Params<'host/pick'>) => Result<'host/pick'>
  openAgent?: (params: Params<'host/openAgent'>) => void | Promise<void>
  /** `document/changed`: show the unsaved mark, tell the agent. */
  changed: (state: KitNotifications['document/changed']) => void
  notify?: (notice: KitNotifications['host/notify']) => void
  /** A host shortcut pressed inside the kit (UI-K5). */
  shortcut?: (key: KitNotifications['host/shortcut']) => void
}

export type MountOptions = {
  /** The kit UI's origin, for the handshake (`location.origin` for a kit served by the host). */
  origin: string
  host: { name: string; version: string }
  document: KitDocumentInit
  theme: KitTheme
  locale: string
  shortcuts: string[]
  handlers: KitHostHandlers
  /** How long the kit may take to open the document. */
  timeoutMs?: number
}

/** A mounted kit UI. */
export type KitConnection = {
  kit: InitializeResult['kit']
  capabilities: string[]
  state: () => Promise<DocumentState>
  save: () => Promise<{ saved: boolean; version: string | null }>
  fileChanged: (version: string) => void
  setTheme: (theme: KitTheme) => void
  setLocale: (locale: string) => void
  focus: () => void
  ai: {
    inspect: () => Promise<Record<string, unknown>>
    commands: (query: string) => Promise<Array<Record<string, unknown>>>
    run: (steps: AiStep[], save: boolean) => Promise<AiRunResult>
    preview: (maxSize: number) => Promise<{ png: string }>
  }
  close: () => void
}

function unsupported(method: string): never {
  throw new KitRpcError(-32601, `${method} is not supported by this host`)
}

/**
 * Hands `frame` (already loaded with the kit's UI entry) its port and initializes it. Resolves
 * when the kit has opened the document; rejects with the kit's error otherwise.
 */
export async function mountKit(frame: HTMLIFrameElement, options: MountOptions): Promise<KitConnection> {
  const target = frame.contentWindow
  if (!target) throw new Error('the kit frame has no window')
  const channel = new MessageChannel()
  const peer: HostPeer = new KitPeer(channel.port1, 'h')
  const { handlers } = options
  peer.handle('host/read', (params) => handlers.read(params))
  peer.handle('host/stamp', (params) => handlers.stamp(params))
  peer.handle('host/write', (params) => handlers.write(params))
  peer.handle('host/pick', (params) => (handlers.pick ? handlers.pick(params) : unsupported('host/pick')))
  peer.handle('host/openAgent', async (params) => {
    if (!handlers.openAgent) unsupported('host/openAgent')
    await handlers.openAgent(params)
    return {}
  })
  peer.on('document/changed', (state) => handlers.changed(state))
  peer.on('host/notify', (notice) => handlers.notify?.(notice))
  peer.on('host/shortcut', (key) => handlers.shortcut?.(key))

  target.postMessage({ kitionKitUi: 1, protocol: KIT_UI_PROTOCOL }, options.origin, [channel.port2])
  const capabilities = ['agent', 'pick-file'].filter((name) => (name === 'agent' ? handlers.openAgent : handlers.pick))
  const document = options.document
  const timeout = options.timeoutMs ?? 120_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const info = await Promise.race([
    peer.request(
      'ui/initialize',
      { protocol: KIT_UI_PROTOCOL, host: options.host, document, theme: options.theme, locale: options.locale, shortcuts: options.shortcuts, capabilities },
      { transfer: true },
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the kit did not open the document in time')), timeout)
    }),
  ]).finally(() => clearTimeout(timer))

  return {
    kit: info.kit,
    capabilities: info.capabilities,
    state: () => peer.request('document/state', {}),
    save: () => peer.request('document/save', {}),
    fileChanged: (version) => peer.notify('document/fileChanged', { version }),
    setTheme: (theme) => peer.notify('ui/theme', { theme }),
    setLocale: (locale) => peer.notify('ui/locale', { locale }),
    focus: () => peer.notify('ui/focus', {}),
    ai: {
      inspect: () => peer.request('ai/inspect', {}),
      commands: (query) => peer.request('ai/commands', { query }),
      run: (steps, save) => peer.request('ai/run', { steps, save }),
      preview: (maxSize) => peer.request('ai/preview', { maxSize }),
    },
    close: () => peer.close(),
  }
}
