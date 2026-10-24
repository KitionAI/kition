// Copied from kition-sdk packages/kit-host/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The host's side of the Kit UI protocol (Kit Harness Protocol (KHP) spec/reference/ui-protocol.md): mount an embedded kit UI in an
 * iframe, hand it its port, initialize it with the document, theme, and locale, and serve its
 * file calls with the host's own handlers. Framework-free.
 */
import {
  KIT_UI_PROTOCOL,
  KitPeer,
  KitRpcError,
  LEASE_HELD_REASON,
  isGeneratePurpose,
  isOpenableUrl,
  isReady,
  parseOpenParams,
  parsePresence,
  parseSchemaReport,
  type AiRunResult,
  type AiStep,
  type DocumentState,
  type HostPeer,
  type InitializeResult,
  type KitConflict,
  type KitDocumentInit,
  type KitLease,
  type KitNotifications,
  type KitPeerPresence,
  type KitPresence,
  type KitPresenceCaret,
  type KitSchemaReport,
  type KitTheme,
  type KitToHost,
  type KitUiConfig,
  type KitUiElement,
  type KitView,
  type DraftComparison,
  type DraftInfo,
  type DraftOrigin,
  type DraftSummary,
  type ModelBatchParams,
  type ModelBatchResult,
  type StoredReplica,
  type KitDiagnostic,
  HOST_ACTION_CAPABILITY_PREFIX,
} from './protocol'
import { FILES_METHODS, openFileSession, type KitFileSession, type KitFilesOptions } from './files'

export { KIT_UI_PROTOCOL, KitRpcError, LEASE_HELD_REASON }
export { fileErrorReason, hostRequestErrorReason, isGeneratePurpose, ACTION_ERROR_REASONS, GENERATE_ERROR_REASONS, GENERATE_PURPOSES } from './protocol'
export { extensionOf, fileError, openFileSession, sanitizeFileName, unusedName, FILES_METHODS } from './files'
export type { FilesMethod, KitFileCommitMode, KitFileEntry, KitFileGrant, KitFileGrantFlow, KitFileRef, KitFileSession, KitFileStaging, KitFilesManifest, KitFilesOptions, KitFilesStorage } from './files'
export type { KitFileErrorReason, KitFileRight, KitFileStat, KitFilesPickParams } from './protocol'
export type { KitActionErrorReason, KitActionParams, KitActionResult, KitDefinedGeneratePurpose, KitGenerateErrorReason, KitGenerateMessage, KitGenerateParams, KitGeneratePart, KitGeneratePurpose, KitGenerateResult } from './protocol'
export type { KitView } from './protocol'
export { parseKitView } from './protocol'
export type { KitLinkRef, KitOpenErrorReason, KitOpenParams, KitOpenResult } from './protocol'
export { isOpenableUrl, openErrorReason, parseLinkRef, parseOpenParams, OPEN_ERROR_REASONS, OPEN_URL_SCHEMES } from './protocol'
export type { DocumentState, DraftComparison, DraftInfo, DraftOrigin, DraftSummary, InitializeResult, KitConflict, KitDocumentInit, KitLease, KitPeerPresence, KitPresence, KitPresenceCaret, KitSchemaReport, KitTheme, KitUiConfig, KitUiElement, ModelBatchParams, ModelBatchResult, StoredReplica }

type Params<M extends keyof KitToHost> = KitToHost[M][0]
type Result<M extends keyof KitToHost> = KitToHost[M][1] | Promise<KitToHost[M][1]>

/** What the host does for the kit. Every path is workspace-relative; the host checks it (UI-H2). */
export type KitHostHandlers = {
  read: (params: Params<'host/read'>) => Result<'host/read'>
  stamp: (params: Params<'host/stamp'>) => Result<'host/stamp'>
  write: (params: Params<'host/write'>) => Result<'host/write'>
  pick?: (params: Params<'host/pick'>) => Result<'host/pick'>
  openAgent?: (params: Params<'host/openAgent'>) => void | Promise<void>
  /**
   * The document's stored replica and its keeping (capability `replica`, with `replicaWrite`):
   * `null` when none is stored. The kit decides whether it still belongs to the file.
   */
  replicaRead?: (params: Params<'host/replicaRead'>) => Result<'host/replicaRead'>
  replicaWrite?: (params: Params<'host/replicaWrite'>) => void | Promise<void>
  /** `replica/changed`: the replica's version after an edit, for collaboration. */
  replicaChanged?: (params: KitNotifications['replica/changed']) => void
  /** `document/changed`: show the unsaved mark, tell the agent. */
  changed: (state: KitNotifications['document/changed']) => void
  notify?: (notice: KitNotifications['host/notify']) => void
  /** A host shortcut pressed inside the kit (UI-K5). */
  shortcut?: (key: KitNotifications['host/shortcut']) => void
  /** `host/customize`: keep the person's hides for this kit (capability `customize`, section 9). */
  customize?: (params: Params<'host/customize'>) => void | Promise<void>
  /** `ui/action`: one of the host's buttons was pressed. */
  action?: (params: KitNotifications['ui/action']) => void
  /**
   * Leases on the document's scopes (capability `lease`, section 7b): `acquire` takes or renews
   * one and keeps it until `release` (or the kit closes, when the host releases what it still
   * holds for it); answers `{ lease: null }` when nobody is there to coordinate with. A refusal
   * throws a `KitRpcError` whose `data` is `{ reason: 'held', lease }` (or `{ reason: 'read-only' }`).
   * `list` is the document's leases now; `KitConnection.leasesChanged` tells the kit of changes.
   */
  leases?: {
    acquire: (params: Params<'host/leaseAcquire'>) => Result<'host/leaseAcquire'>
    release: (params: Params<'host/leaseRelease'>) => void | Promise<void>
    list: () => KitLease[] | Promise<KitLease[]>
  }
  /** `document/conflicts`: the document's unresolved conflict objects (section 7c). */
  conflicts?: (params: KitNotifications['document/conflicts']) => void
  /**
   * `document/schema`: a newer kit edited the document (section 7f; KHP 2.0 rule M5a),
   * checked. The host tells the person and offers the update, without blocking editing.
   */
  schema?: (params: KitNotifications['document/schema']) => void
  /** `draft/changed`: the agent's draft opened, changed, became ready, or closed (section 7d). */
  draftChanged?: (params: KitNotifications['draft/changed']) => void
  /**
   * `presence/set`: what the person shares with the other people in the document (capability
   * `presence`, section 7e), checked; the host relays it to them. `KitConnection.peersChanged`
   * tells the kit what they share.
   */
  presence?: (presence: KitPresence) => void
  /**
   * `host/generate`: run a model for the kit with the person's settings (capability `generate`,
   * section 7j). Refuse with a `KitRpcError(-32000, …, { reason })`, `reason` one of
   * `GENERATE_ERROR_REASONS`. Never give the kit a key or an endpoint (UI-G2). A purpose that is
   * neither defined nor the kit's own (`isGeneratePurpose`) is refused as `not-allowed` before
   * it gets here; the host MAY refuse a kit's own purpose too, and serves every defined one.
   */
  generate?: (params: Params<'host/generate'>) => Result<'host/generate'>
  /**
   * `host/action`: the host's actions by id, each listed as capability `action:<id>` (section
   * 7j), such as `workflow.run` and `design.fromRecord`. An id the host does not serve is refused
   * with reason `not-allowed`.
   */
  actions?: Record<string, (params: Record<string, unknown>) => Result<'host/action'>>
  /**
   * `host/open`: open a workspace file in the host (capability `open-file`, section 7i; KitLinks
   * 1.0 OP1 to OP5), with its `view` (OP3), creating a missing one when asked (OP4). The params
   * arrive checked (`parseOpenParams`); the host resolves the link against the document's folder,
   * keeps it inside the workspace (UI-H2), and refuses with a `KitRpcError(-32000, …, { reason })`,
   * `reason` one of `OPEN_ERROR_REASONS`.
   */
  open?: (params: Params<'host/open'>) => Result<'host/open'>
  /**
   * `host/openUrl`: open a web address in the system's browser or mail client after the person
   * confirmed it (capability `open-url`; OP6 to OP9). Only `https:`, `http:`, and `mailto:` reach
   * it: others are refused as `not-allowed` before (OP7).
   */
  openUrl?: (params: Params<'host/openUrl'>) => Result<'host/openUrl'>
}

export type MountOptions = {
  /** The kit UI's origin, for the handshake (`location.origin` for a kit served by the host). */
  origin: string
  host: { name: string; version: string }
  document: KitDocumentInit
  theme: KitTheme
  locale: string
  shortcuts: string[]
  /** The UI configuration (protocol section 9). */
  ui?: KitUiConfig
  /** The capability sets the host serves (`ui/initialize` `capabilitySets`), such as `KitCollab 1.0`. */
  capabilitySets?: string[]
  handlers: KitHostHandlers
  /**
   * Serves KitFiles 1.0 (`files/*`, protocol section 7g): the host's storage, the kit manifest's
   * `files` lists, its picker and printer. Lists `files`, and `files-pick` and `print` when it
   * has them. Each kit document the frame loads gets its own grant table, ended with it.
   */
  files?: KitFilesOptions
  /** How long the kit may take to open the document. */
  timeoutMs?: number
  /** Abandons the mount (the frame went away first): stops listening and rejects. */
  signal?: AbortSignal
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
  /**
   * Replaces the UI configuration (`ui/configure`). A host that mounts the kit again passes its
   * latest configuration as the `ui` option.
   */
  configure: (ui: KitUiConfig) => void
  /** Tells the kit the document's leases changed (`lease/changed`, capability `lease`). */
  leasesChanged: (leases: KitLease[]) => void
  /** Tells the kit who else is in the document and what they share (`presence/peers`, capability `presence`): the whole list. */
  peersChanged: (peers: KitPeerPresence[]) => void
  /**
   * Shows `view` in the open document (`document/reveal`, section 7i, OP3), as the `document.view`
   * a new editor opens at. A kit that cannot show it ignores it.
   */
  reveal: (view: KitView) => void
  /**
   * Hears every `presence/set` the kit sends (what the person selected, where their caret is),
   * checked; answers an unsubscribe. The object model's `selection` event follows it.
   */
  onPresence: (listener: (presence: KitPresence) => void) => () => void
  /** The editor's elements (`ui/elements`). Rejects with -32601 when the kit did not declare its UI. */
  elements: () => Promise<KitUiElement[]>
  /**
   * The engine's diagnostics on the document (`document/check`, capability `check`), errors first;
   * `draft` checks the agent's draft. A kit without the capability answers no diagnostics here.
   */
  check: (options?: { draft?: boolean }) => Promise<KitDiagnostic[]>
  /** The Kit AI bridge; `draft` (capability `draft`) works on the agent's draft instead of the live document. */
  ai: {
    inspect: (options?: { draft?: boolean }) => Promise<Record<string, unknown>>
    commands: (query: string) => Promise<Array<Record<string, unknown>>>
    run: (steps: AiStep[], save: boolean, options?: { draft?: boolean }) => Promise<AiRunResult>
    preview: (maxSize: number, options?: { draft?: boolean }) => Promise<{ png: string }>
  }
  /**
   * The agent's draft, when the kit lists the `draft` capability (section 7d). `ready` and
   * `reopen` may be the agent's; `merge` and `discard` MUST come from the person's explicit
   * approval, never from a model.
   */
  draft: {
    state: () => Promise<DraftInfo>
    ready: () => Promise<DraftInfo>
    reopen: () => Promise<DraftInfo>
    compare: (options?: { maxSize?: number; schema?: object }) => Promise<DraftComparison>
    merge: (origin: DraftOrigin, schema?: object) => Promise<{ merged: boolean; summary: DraftSummary }>
    discard: () => Promise<DraftInfo>
  }
  /** The document's KDM replica, when the kit declares the `replica` capability. */
  replica: {
    version: () => Promise<ArrayBuffer>
    exportChanges: (since: ArrayBuffer) => Promise<{ changes: ArrayBuffer; blobs: ArrayBuffer }>
    importChanges: (changes: ArrayBuffer, blobs: ArrayBuffer) => Promise<{ damage: unknown }>
    /** The replica's own id (minor version 1.3), when the kit's engine has one; `null` otherwise. */
    info: () => Promise<string | null>
    /** Hears every `replica/changed` (the replica's version after an edit); answers an unsubscribe. */
    onChanged: (listener: (version: ArrayBuffer) => void) => () => void
  }
  /**
   * The object model answered by the kit itself, when it lists the `model` capability (section
   * 7a): a batch is one undo step of the kit's own history. A refused batch rejects with a
   * `KitRpcError` whose `data` is `{ code, index, message }`.
   */
  model: {
    describe: (schema?: object) => Promise<Record<string, unknown>>
    batch: (params: ModelBatchParams) => Promise<ModelBatchResult>
  }
  /**
   * The session's file grants, when the host serves `files` (KitFiles 1.0): grant a handle for an
   * agent's `file` parameter or a drop, revoke handles, list what the kit holds (FA16).
   */
  files: Pick<KitFileSession, 'grant' | 'revoke' | 'grants'> | null
  close: () => void
}

function unsupported(method: string): never {
  throw new KitRpcError(-32601, `${method} is not supported by this host`)
}

/**
 * Hands `frame` (already loaded with the kit's UI entry) its port and initializes it. Resolves
 * when the kit has opened the document; rejects with the kit's error otherwise.
 */
export function mountKit(frame: HTMLIFrameElement, options: MountOptions): Promise<KitConnection> {
  const { handlers } = options
  const served = { agent: handlers.openAgent, 'pick-file': handlers.pick, replica: handlers.replicaRead && handlers.replicaWrite, customize: handlers.customize, lease: handlers.leases, presence: handlers.presence }
  const capabilities = Object.entries(served).filter(([, handler]) => handler).map(([name]) => name)
  if (handlers.generate) capabilities.push('generate')
  if (handlers.open) capabilities.push('open-file')
  if (handlers.openUrl) capabilities.push('open-url')
  const actions = Object.entries(handlers.actions ?? {}).filter(([, run]) => typeof run === 'function')
  capabilities.push(...actions.map(([id]) => `${HOST_ACTION_CAPABILITY_PREFIX}${id}`))
  if (options.files) capabilities.push('files', ...(options.files.pick ? ['files-pick'] : []), ...(options.files.print ? ['print'] : []))
  const timeout = options.timeoutMs ?? 120_000

  /** One attempt: a channel to the kit document that announced itself as `id`. */
  const attempt = (target: Window, id: string) => {
    const channel = new MessageChannel()
    const peer: HostPeer = new KitPeer(channel.port1, 'h')
    /** The kit's id, once its `ui/initialize` answer named it. */
    let kitId: string | null = null
    peer.handle('host/read', (params) => handlers.read(params))
    peer.handle('host/stamp', (params) => handlers.stamp(params))
    peer.handle('host/write', (params) => handlers.write(params))
    peer.handle('host/pick', (params) => (handlers.pick ? handlers.pick(params) : unsupported('host/pick')))
    peer.handle('host/openAgent', async (params) => {
      if (!handlers.openAgent) unsupported('host/openAgent')
      await handlers.openAgent(params)
      return {}
    })
    const { replicaRead, replicaWrite } = handlers
    peer.handle('host/replicaRead', (params) => (replicaRead && replicaWrite ? replicaRead(params) : unsupported('host/replicaRead')))
    peer.handle('host/replicaWrite', async (params) => {
      if (!replicaRead || !replicaWrite) unsupported('host/replicaWrite')
      await replicaWrite(params)
      return {}
    })
    peer.handle('host/customize', async (params) => {
      if (!handlers.customize) unsupported('host/customize')
      await handlers.customize(params)
      return {}
    })
    peer.handle('host/leaseAcquire', (params) => (handlers.leases ? handlers.leases.acquire(params) : unsupported('host/leaseAcquire')))
    peer.handle('host/leaseRelease', async (params) => {
      if (!handlers.leases) unsupported('host/leaseRelease')
      await handlers.leases.release(params)
      return {}
    })
    peer.handle('host/leases', async () => {
      if (!handlers.leases) unsupported('host/leases')
      return { leases: await handlers.leases.list() }
    })
    peer.handle('host/generate', (params) => {
      if (!handlers.generate) unsupported('host/generate')
      if (!isGeneratePurpose(params?.purpose, kitId)) throw new KitRpcError(-32000, `a kit may not generate for ${JSON.stringify(params?.purpose)}`, { reason: 'not-allowed' })
      return handlers.generate(params)
    })
    peer.handle('host/action', (params) => {
      const run = typeof params?.id === 'string' ? actions.find(([id]) => id === params.id)?.[1] : undefined
      if (!run) throw new KitRpcError(-32000, `this host does not serve the action ${String(params?.id)}`, { reason: 'not-allowed' })
      return run(params.params && typeof params.params === 'object' ? params.params : {})
    })
    peer.handle('host/open', async (params) => {
      if (!handlers.open) unsupported('host/open')
      const checked = parseOpenParams(params)
      if (!checked) throw new KitRpcError(-32602, 'host/open needs a link with a path, a name, or a docId')
      const answer = await handlers.open(checked)
      return { opened: answer?.opened !== false }
    })
    peer.handle('host/openUrl', async (params) => {
      if (!handlers.openUrl) unsupported('host/openUrl')
      if (!isOpenableUrl(params?.url)) throw new KitRpcError(-32000, `a host opens only https:, http:, and mailto: addresses`, { reason: 'not-allowed' })
      const answer = await handlers.openUrl({ url: params.url })
      return { opened: answer?.opened !== false }
    })
    const files = options.files ? openFileSession({ ...options.files, readOnly: options.document.readOnly === true, revoked: (handles) => peer.notify('files/revoked', { handles }) }) : null
    if (files) for (const method of FILES_METHODS) peer.handle(method, (params) => files.serve(method, params as never))
    peer.on('document/conflicts', (params) => handlers.conflicts?.(params))
    peer.on('document/schema', (params) => {
      const report = parseSchemaReport(params)
      if (report) handlers.schema?.(report)
    })
    peer.on('draft/changed', (params) => handlers.draftChanged?.(params))
    peer.on('presence/set', (params) => {
      const presence = parsePresence(params)
      if (presence) handlers.presence?.(presence)
    })
    peer.on('document/changed', (state) => handlers.changed(state))
    peer.on('replica/changed', (params) => handlers.replicaChanged?.(params))
    peer.on('host/notify', (notice) => handlers.notify?.(notice))
    peer.on('host/shortcut', (key) => handlers.shortcut?.(key))
    peer.on('ui/action', (params) => handlers.action?.(params))
    target.postMessage({ kitionKitUi: 1, protocol: KIT_UI_PROTOCOL, id }, options.origin, [channel.port2])
    // Each attempt sends the document's bytes; the transfer leaves this copy intact for the next.
    const document = { ...options.document, bytes: options.document.bytes?.slice(0) }
    const initialized = peer.request(
      'ui/initialize',
      { protocol: KIT_UI_PROTOCOL, host: options.host, document, theme: options.theme, locale: options.locale, shortcuts: options.shortcuts, capabilities, capabilitySets: options.capabilitySets ?? [], ui: options.ui },
      { transfer: true },
    )
    // The kit's own generation purposes are known once it named itself (before that, the defined ones).
    void initialized.then(
      (answer) => {
        kitId = typeof answer?.kit?.id === 'string' ? answer.kit.id : null
      },
      () => undefined,
    )
    return { peer, files, initialized }
  }

  return new Promise((resolve, reject) => {
    let current: { peer: HostPeer; files: KitFileSession | null; id: string } | null = null
    const stop = (attempt: { peer: HostPeer; files: KitFileSession | null } | null) => {
      attempt?.peer.close()
      void attempt?.files?.end()
    }
    const finish = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      finish()
      stop(current)
      reject(new Error('the kit mount was abandoned'))
    }
    if (options.signal?.aborted) {
      reject(new Error('the kit mount was abandoned'))
      return
    }
    options.signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      finish()
      stop(current)
      reject(new Error('the kit did not open the document in time'))
    }, timeout)
    // A kit document announced itself: connect to it. A newer one (the frame navigated, or the
    // first answer came from the page it replaced) starts over with a new channel.
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !isReady(event.data) || event.data.ready !== KIT_UI_PROTOCOL) return
      if (options.origin !== '*' && event.origin !== options.origin) return
      if (current?.id === event.data.id) return
      stop(current)
      const { peer, files, initialized } = attempt(event.source as Window, event.data.id)
      current = { peer, files, id: event.data.id }
      initialized.then(
        (info) => {
          if (current?.peer !== peer) return
          finish()
          resolve(connection(peer, info, files))
        },
        (error: unknown) => {
          if (current?.peer !== peer) return
          finish()
          void files?.end()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    }
    window.addEventListener('message', onMessage)
    // A kit that loaded before this listened announced itself to no one; ask it again.
    frame.contentWindow?.postMessage({ kitionKitUi: 1, hello: KIT_UI_PROTOCOL }, options.origin)
  })
}

function connection(peer: HostPeer, info: { kit: KitConnection['kit']; capabilities: string[] }, files: KitFileSession | null): KitConnection {
  return {
    kit: info.kit,
    capabilities: info.capabilities,
    state: () => peer.request('document/state', {}),
    save: () => peer.request('document/save', {}),
    fileChanged: (version) => peer.notify('document/fileChanged', { version }),
    setTheme: (theme) => peer.notify('ui/theme', { theme }),
    setLocale: (locale) => peer.notify('ui/locale', { locale }),
    focus: () => peer.notify('ui/focus', {}),
    configure: (ui) => peer.notify('ui/configure', { ui }),
    leasesChanged: (leases) => peer.notify('lease/changed', { leases }),
    peersChanged: (peers) => peer.notify('presence/peers', { peers }),
    reveal: (view) => peer.notify('document/reveal', { view }),
    onPresence: (listener) =>
      peer.on('presence/set', (params) => {
        const presence = parsePresence(params)
        if (presence) listener(presence)
      }),
    elements: () => peer.request('ui/elements', {}),
    check: async (options) => (info.capabilities.includes('check') ? (await peer.request('document/check', options?.draft ? { draft: true } : {})).diagnostics : []),
    ai: {
      inspect: (options) => peer.request('ai/inspect', options?.draft ? { draft: true } : {}),
      commands: (query) => peer.request('ai/commands', { query }),
      run: (steps, save, options) => peer.request('ai/run', options?.draft ? { steps, save, draft: true } : { steps, save }),
      preview: (maxSize, options) => peer.request('ai/preview', options?.draft ? { maxSize, draft: true } : { maxSize }),
    },
    draft: {
      state: () => peer.request('draft/state', {}),
      ready: () => peer.request('draft/ready', {}),
      reopen: () => peer.request('draft/reopen', {}),
      compare: (options) => peer.request('draft/compare', options ?? {}),
      merge: (origin, schema) => peer.request('draft/merge', schema ? { origin, schema } : { origin }),
      discard: () => peer.request('draft/discard', {}),
    },
    replica: {
      version: async () => (await peer.request('replica/version', {})).version,
      exportChanges: (since) => peer.request('replica/export', { since }),
      importChanges: (changes, blobs) => peer.request('replica/import', { changes, blobs }),
      info: async () => (await peer.request('replica/info', {})).docId,
      onChanged: (listener) => peer.on('replica/changed', (params) => listener(params.version)),
    },
    model: {
      describe: (schema) => peer.request('model/describe', schema ? { schema } : {}),
      batch: (params) => peer.request('model/batch', params),
    },
    files: files && { grant: files.grant, revoke: files.revoke, grants: files.grants },
    close: () => {
      peer.close()
      void files?.end()
    },
  }
}
