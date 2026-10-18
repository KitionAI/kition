// Copied from kition-sdk packages/extensions/src/host.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `ExtensionHost`: loads extensions, runs each in its own sandbox, activates it per document, and
 * serves it the object model of the documents it is active on, checked against its permissions.
 */
import { BatchError, type BatchRequest, type Origin } from '../kdm'
import { kitDescriptor, openDocument, type KitCommandInfo, type ModelDocument, type ModelPort } from '../sdk'
// Every generated kit's schema: extensions work on documents of any of them.
import '../sdk/kits/index'
import { checkBatch, requirePermission } from './gate'
import { appliesTo, connectSources, hasPermission, panelAppliesTo, parseManifest, type ExtensionCommand, type ExtensionManifest, type ExtensionPanel, type Permission } from './manifest'
import type { DocumentInfo, Notice } from './protocol'
import { ExtensionError, RpcPeer, type PortLike } from './rpc'

/**
 * An installed extension: its manifest, its entry module's source, and its other files as text
 * by package path (each panel's HTML entry).
 */
export type ExtensionPackage = { manifest: ExtensionManifest | unknown; source: string; files?: Record<string, string> }

/** A started sandbox: the channel to its worker, and how to tear it down. */
export type SandboxConnection = { port: PortLike; dispose: () => void }

/**
 * Starts a sandbox for one extension: a worker on an opaque origin that runs `runtime` and may
 * reach only `connect` (a CSP `connect-src` value). `iframeSandbox` is the one for pages.
 */
export type SandboxFactory = (options: { id: string; connect: string }) => Promise<SandboxConnection>

/** A document open in the host that extensions may work on. */
export type HostDocument = {
  /** The host's id for it (Kition: its workspace path). */
  id: string
  kitId: string
  /** Its path or file name; `activation.formats` match its extension. */
  path?: string
  /** The document's object model port (`portFromConnection`, `portFromEngine`, …). */
  port: ModelPort
  /** The kit's schema when the kit is not registered with `@kition/sdk` (`registerKit`). */
  schema?: object
}

export type ExtensionNotice = Notice & { extension: string }

export type ExtensionHostOptions = {
  sandbox: SandboxFactory
  /** The kit's schema for documents that bring none; `@kition/sdk`'s registered kits otherwise. */
  schema?: (kitId: string) => object | undefined
  /** `ctx.notify` of extensions, and the host's reports of their failures. */
  notify?: (notice: ExtensionNotice) => void
  /** How long a sandbox may take to start an extension (ms). */
  startTimeoutMs?: number
}

/** A contributed command as a host lists it (palette, menus). */
export type ContributedCommand = ExtensionCommand & { extension: string; extensionName: string }

/** A contributed panel as a host lists it. */
export type ContributedPanel = ExtensionPanel & { extension: string; extensionName: string }

/** What a host needs to show a panel: its HTML and its `connect-src` (the extension's). */
export type PanelContent = { html: string; connect: string; title: string }

/** A panel open on a document; `close` ends it in the extension's worker. */
export type PanelSession = { session: string; close: () => void }

/** The permissions of a script run with `runScript`. */
export const SCRIPT_PERMISSIONS: Permission[] = ['model.read', 'model.write', 'commands.run']

type Activation = { commands: Set<string>; unsubscribe: () => void }
type Running = { peer: RpcPeer; connection: SandboxConnection; activations: Map<string, Activation> }
type Loaded = {
  manifest: ExtensionManifest
  source: string
  /** Each panel's HTML, by panel id. */
  panels: Map<string, string>
  principal: string
  running: Promise<Running> | null
  activating: Map<string, Promise<Activation>>
}
type OpenDocument = { document: HostDocument; model: Promise<ModelDocument> | null }

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class ExtensionHost {
  private loaded = new Map<string, Loaded>()
  private documents = new Map<string, OpenDocument>()
  private scripts = 0
  private panelSessions = 0

  constructor(private readonly options: ExtensionHostOptions) {}

  /** Checks and loads an extension (its code runs when it is first activated); replaces one with its id. */
  load(pkg: ExtensionPackage): ExtensionManifest {
    const manifest = parseManifest(pkg.manifest)
    if (typeof pkg.source !== 'string' || !pkg.source.trim()) throw new ExtensionError('invalid', `${manifest.id} has no code in ${manifest.entry}`)
    const panels = new Map<string, string>()
    for (const panel of manifest.contributes.panels ?? []) {
      const html = pkg.files?.[panel.entry]
      if (typeof html !== 'string' || !html.trim()) throw new ExtensionError('invalid', `${manifest.id} has no ${panel.entry} for its panel ${panel.id}`)
      panels.set(panel.id, html)
    }
    this.unload(manifest.id)
    this.loaded.set(manifest.id, { manifest, source: pkg.source, panels, principal: `ext:${manifest.id}`, running: null, activating: new Map() })
    for (const open of this.documents.values()) {
      if (manifest.activation.on === 'open' && appliesTo(manifest, open.document)) void this.activateReporting(manifest.id, open.document.id)
    }
    return manifest
  }

  /** Deactivates an extension everywhere and stops its sandbox. */
  unload(id: string) {
    const loaded = this.loaded.get(id)
    if (!loaded) return
    this.loaded.delete(id)
    void this.stop(loaded)
  }

  extensions(): ExtensionManifest[] {
    return [...this.loaded.values()].map((loaded) => loaded.manifest)
  }

  /** Offers a document to extensions; those that activate on open do. Answers `closeDocument`. */
  openDocument(document: HostDocument): () => void {
    this.closeDocument(document.id)
    this.documents.set(document.id, { document, model: null })
    for (const loaded of this.loaded.values()) {
      if (loaded.manifest.activation.on === 'open' && appliesTo(loaded.manifest, document)) void this.activateReporting(loaded.manifest.id, document.id)
    }
    return () => {
      if (this.documents.get(document.id)?.document === document) this.closeDocument(document.id)
    }
  }

  /** Deactivates every extension on the document. */
  closeDocument(id: string) {
    const open = this.documents.get(id)
    if (!open) return
    this.documents.delete(id)
    for (const loaded of this.loaded.values()) void this.deactivate(loaded, id)
    void open.model?.then((model) => model.close()).catch(() => undefined)
  }

  /** The commands loaded extensions contribute to a document, in load order. */
  commandsFor(documentId: string): ContributedCommand[] {
    const open = this.documents.get(documentId)
    if (!open) return []
    return [...this.loaded.values()]
      .filter((loaded) => appliesTo(loaded.manifest, open.document))
      .flatMap((loaded) => loaded.manifest.contributes.commands.map((command) => ({ ...command, extension: loaded.manifest.id, extensionName: loaded.manifest.name })))
  }

  /** The panels loaded extensions contribute to a document, in load order. */
  panelsFor(documentId: string): ContributedPanel[] {
    const open = this.documents.get(documentId)
    if (!open) return []
    return [...this.loaded.values()].flatMap((loaded) =>
      (loaded.manifest.contributes.panels ?? [])
        .filter((panel) => panelAppliesTo(loaded.manifest, panel, open.document))
        .map((panel) => ({ ...panel, extension: loaded.manifest.id, extensionName: loaded.manifest.name })),
    )
  }

  /** A contributed panel's HTML and the network origins its frame may reach (the extension's). */
  panelContent(extensionId: string, panelId: string): PanelContent {
    const loaded = this.require(extensionId)
    const panel = loaded.manifest.contributes.panels?.find((contributed) => contributed.id === panelId)
    const html = loaded.panels.get(panelId)
    if (!panel || html === undefined) throw new ExtensionError('not-found', `${extensionId} contributes no panel ${panelId}`)
    return { html, connect: connectSources(loaded.manifest.permissions), title: panel.title }
  }

  /**
   * Opens a contributed panel on a document: activates the extension there first when needed, then
   * hands its worker `port`, the worker's end of the panel's channel (the panel's frame gets the
   * other end). Answers the session; closing the document or the extension closes it too.
   */
  async openPanel(documentId: string, extensionId: string, panelId: string, port: MessagePort): Promise<PanelSession> {
    const loaded = this.require(extensionId)
    const panel = loaded.manifest.contributes.panels?.find((contributed) => contributed.id === panelId)
    if (!panel) throw new ExtensionError('not-found', `${extensionId} contributes no panel ${panelId}`)
    const open = this.documents.get(documentId)
    if (!open) throw new ExtensionError('not-found', `no open document ${documentId}`)
    if (!panelAppliesTo(loaded.manifest, panel, open.document)) throw new ExtensionError('invalid', `${extensionId}'s panel ${panelId} does not apply to ${open.document.kitId} documents`)
    await this.activate(extensionId, documentId)
    const running = await loaded.running!
    const session = `panel-${++this.panelSessions}`
    await running.peer.request('panel/open', { documentId, panel: panelId, session }, 20_000, [port])
    return {
      session,
      close: () => void running.peer.request('panel/close', { session }, 5_000).catch(() => undefined),
    }
  }

  /** Runs a contributed command on a document, activating its extension first when needed. */
  async runCommand(documentId: string, extensionId: string, commandId: string): Promise<unknown> {
    const loaded = this.require(extensionId)
    if (!loaded.manifest.contributes.commands.some((command) => command.id === commandId)) throw new ExtensionError('not-found', `${extensionId} contributes no command ${commandId}`)
    const activation = await this.activate(extensionId, documentId)
    if (!activation.commands.has(commandId)) throw new ExtensionError('not-found', `${extensionId} did not register ${commandId} when it activated`)
    const running = await loaded.running!
    return running.peer.request('extension/command', { documentId, command: commandId })
  }

  /** Activates an extension on a document (once); answers when its `activate` has returned. */
  activate(extensionId: string, documentId: string): Promise<Activation> {
    const loaded = this.require(extensionId)
    const known = loaded.activating.get(documentId)
    if (known) return known
    const activating = (async () => {
      const open = this.documents.get(documentId)
      if (!open) throw new ExtensionError('not-found', `no open document ${documentId}`)
      if (!appliesTo(loaded.manifest, open.document)) throw new ExtensionError('invalid', `${extensionId} does not apply to ${open.document.kitId} documents`)
      const model = await this.model(documentId)
      const running = await this.start(loaded)
      // Registered before `activate` runs: it registers its commands and may edit right away.
      const activation: Activation = { commands: new Set(), unsubscribe: () => undefined }
      running.activations.set(documentId, activation)
      activation.unsubscribe = model.on('changed', (event) => running.peer.notify('document/changed', { documentId, origin: event.origin }))
      try {
        const { commands } = await running.peer.request<{ commands: string[] }>('extension/activate', this.info(open.document, loaded.manifest.permissions, model))
        for (const command of commands) activation.commands.add(command)
      } catch (error) {
        activation.unsubscribe()
        if (running.activations.get(documentId) === activation) running.activations.delete(documentId)
        throw error
      }
      return activation
    })()
    loaded.activating.set(documentId, activating)
    activating.catch(() => {
      if (loaded.activating.get(documentId) === activating) loaded.activating.delete(documentId)
    })
    return activating
  }

  /**
   * Runs a script (an ES module whose default export, or `run`, takes the same `ctx` as
   * `activate`) once against a document, in a sandbox of its own with `permissions`. Answers what
   * it answers.
   */
  async runScript(script: { source: string; name?: string }, documentId: string, permissions: Permission[] = SCRIPT_PERMISSIONS): Promise<unknown> {
    const open = this.documents.get(documentId)
    if (!open) throw new ExtensionError('not-found', `no open document ${documentId}`)
    const name = (script.name ?? 'script').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'script'
    const id = `script-${++this.scripts}`
    const manifest: ExtensionManifest = {
      kitExtensions: '1.0',
      id,
      name,
      version: '0.0.0',
      entry: 'script.mjs',
      activation: { kits: [open.document.kitId] },
      contributes: { commands: [] },
      permissions,
    }
    const loaded: Loaded = { manifest, source: script.source, panels: new Map(), principal: `script:${name}`, running: null, activating: new Map() }
    try {
      const running = await this.start(loaded, 'script')
      const model = await this.model(documentId)
      running.activations.set(documentId, { commands: new Set(), unsubscribe: () => undefined })
      return await running.peer.request('script/run', this.info(open.document, permissions, model))
    } finally {
      await this.stop(loaded)
    }
  }

  /** Stops every sandbox and forgets every document. */
  dispose() {
    for (const id of [...this.loaded.keys()]) this.unload(id)
    for (const id of [...this.documents.keys()]) this.closeDocument(id)
  }

  private require(id: string): Loaded {
    const loaded = this.loaded.get(id)
    if (!loaded) throw new ExtensionError('not-found', `no extension ${id} is loaded`)
    return loaded
  }

  private info(document: HostDocument, permissions: readonly string[], model: ModelDocument): DocumentInfo {
    const readOnly = !hasPermission(permissions, 'model.write') || (document.port.readOnly?.() ?? false)
    const name = document.path?.split('/').pop()
    return { documentId: document.id, kitId: document.kitId, ...(name ? { name } : {}), schema: model.schema as unknown as object, readOnly }
  }

  private async activateReporting(extensionId: string, documentId: string) {
    try {
      await this.activate(extensionId, documentId)
    } catch (error) {
      this.report(extensionId, error)
    }
  }

  private report(extension: string, error: unknown) {
    this.options.notify?.({ extension, level: 'error', title: this.loaded.get(extension)?.manifest.name ?? extension, description: describeError(error) })
  }

  /** The document's object model, opened once and shared by every extension on it. */
  private model(documentId: string): Promise<ModelDocument> {
    const open = this.documents.get(documentId)
    if (!open) return Promise.reject(new ExtensionError('not-found', `no open document ${documentId}`))
    if (!open.model) {
      const { document } = open
      const schema = document.schema ?? this.options.schema?.(document.kitId) ?? kitDescriptor(document.kitId)?.schema
      open.model = schema
        ? openDocument(document.port, { schema })
        : Promise.reject(new ExtensionError('invalid', `extensions cannot work on ${document.kitId} documents yet: the host knows no schema for that kit`))
      open.model.catch(() => {
        if (this.documents.get(documentId) === open) open.model = null
      })
    }
    return open.model
  }

  /** The sandbox of an extension, started once. */
  private start(loaded: Loaded, kind: 'extension' | 'script' = 'extension'): Promise<Running> {
    if (loaded.running) return loaded.running
    const running = (async () => {
      const connection = await this.options.sandbox({ id: loaded.manifest.id, connect: connectSources(loaded.manifest.permissions) })
      const peer = new RpcPeer(connection.port)
      const result: Running = { peer, connection, activations: new Map() }
      this.serve(loaded, result)
      try {
        await peer.request('extension/start', { manifest: loaded.manifest, source: loaded.source, kind }, this.options.startTimeoutMs ?? 20_000)
      } catch (error) {
        peer.close()
        connection.dispose()
        throw error
      }
      return result
    })()
    loaded.running = running
    running.catch(() => {
      if (loaded.running === running) loaded.running = null
    })
    return running
  }

  private async stop(loaded: Loaded) {
    const running = await loaded.running?.catch(() => null)
    loaded.running = null
    if (!running) return
    for (const id of [...running.activations.keys()]) await this.deactivate(loaded, id, running)
    running.peer.close('the extension was stopped')
    running.connection.dispose()
  }

  private async deactivate(loaded: Loaded, documentId: string, known?: Running) {
    loaded.activating.delete(documentId)
    const running = known ?? (await loaded.running?.catch(() => null))
    const activation = running?.activations.get(documentId)
    if (!running || !activation) return
    running.activations.delete(documentId)
    activation.unsubscribe()
    await running.peer.request('extension/deactivate', { documentId }, 5_000).catch(() => undefined)
  }

  /** What the extension's worker may ask of the host. */
  private serve(loaded: Loaded, running: Running) {
    const { manifest, principal } = loaded
    const id = manifest.id
    const permissions = manifest.permissions
    const active = async (documentId: unknown) => {
      if (typeof documentId !== 'string' || !running.activations.has(documentId)) throw new ExtensionError('not-found', `${id} is not active on ${String(documentId)}`)
      return this.model(documentId)
    }
    const origin: Origin = { kind: 'extension', principal }
    running.peer
      .handle('model/batch', async ({ documentId, request }: { documentId: string; request: BatchRequest }) => {
        const model = await active(documentId)
        await checkBatch(id, permissions, request, () => model.commands.list())
        try {
          // The host says who made the change; an extension cannot claim another origin.
          return await model.batch({ ops: request.ops ?? [], load: request.load ?? [], origin })
        } catch (error) {
          if (error instanceof BatchError) throw new ExtensionError(error.code, error.message, { index: error.index })
          throw error
        }
      })
      .handle('model/describe', async ({ documentId }: { documentId: string }) => {
        const model = await active(documentId)
        requirePermission(id, permissions, 'model.read', 'read the document')
        return model.describe()
      })
      .handle('model/commands', async ({ documentId }: { documentId: string }): Promise<KitCommandInfo[]> => {
        const model = await active(documentId)
        if (!hasPermission(permissions, 'commands.run')) requirePermission(id, permissions, 'model.read', 'list the commands')
        return model.commands.list()
      })
      .handle('commands/register', ({ documentId, command }: { documentId: string; command: string }) => {
        const activation = running.activations.get(documentId)
        if (!activation) throw new ExtensionError('not-found', `${id} is not active on ${documentId}`)
        if (!manifest.contributes.commands.some((contributed) => contributed.id === command)) {
          throw new ExtensionError('invalid', `${id} does not contribute ${command}: declare it in extension.json contributes.commands`)
        }
        activation.commands.add(command)
        return null
      })
      .handle('host/notify', (notice: Notice) => {
        const level = ['info', 'success', 'warning', 'error'].includes(notice?.level) ? notice.level : 'info'
        const title = String(notice?.title ?? '').slice(0, 200)
        if (!title) return null
        const description = notice.description === undefined ? undefined : String(notice.description).slice(0, 1000)
        this.options.notify?.({ extension: id, level, title, ...(description ? { description } : {}) })
        return null
      })
  }
}
