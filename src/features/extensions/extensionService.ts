/**
 * Kition's extension host: installed extensions (from the app's storage) loaded into one
 * `ExtensionHost`, every open kit editor offered to them, and scripts run against the kit document
 * shown now. Extensions run sandboxed (`@/lib/extensions`): only their declared permissions reach
 * the document, and only their declared origins the network.
 */
import i18next from 'i18next'
import { activeKitDocument, followKitConnections, KITION_KIT_HOST, type MountedKitDocument } from '@/features/kits/public'
import { ExtensionHost, iframeSandbox, openPanelFrame, type ContributedCommand, type ContributedPanel, type ExtensionNotice, type PanelFrame, type SandboxFactory } from '@/lib/extensions'
import { notify } from '@/lib/notify'
import { portFromConnection, type ConnectionLike } from '@/lib/sdk'
// Registers the kits whose documents extensions can work on (their object-model schemas).
import '@/lib/sdk/kits/index'
import { deleteInstalledExtension, listInstalledExtensions, putInstalledExtension, type InstalledExtension } from './extensionStore'
import { cleanWorkspacePath, readExtensionFromWorkspace } from './extensionPackage'
import { announceExtensionService } from './serviceAnnouncement'

/** Where Kition serves the sandbox page (public/extensions/sandbox.html). */
export const SANDBOX_URL = '/extensions/sandbox.html'
/** Where Kition serves the panel page (public/extensions/panel.html). */
export const PANEL_URL = '/extensions/panel.html'

export type ExtensionsSnapshot = { ready: boolean; installed: InstalledExtension[] }

/** A command the palette offers for the kit document shown now. */
export type PaletteExtensionCommand = ContributedCommand & { documentPath: string }

/** A panel the palette offers for the kit document shown now. */
export type PaletteExtensionPanel = ContributedPanel & { documentPath: string }

const t = (key: string, options?: Record<string, unknown>) => i18next.t(key, { ns: 'common', ...options }) as string

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readWorkspaceFile = async (path: string) => (await KITION_KIT_HOST.read(path)).bytes

export class ExtensionService {
  readonly host: ExtensionHost
  private snapshot: ExtensionsSnapshot = { ready: false, installed: [] }
  private listeners = new Set<() => void>()
  private stopFollowing: (() => void) | null = null
  readonly ready: Promise<void>

  constructor(options: { sandbox?: SandboxFactory; notify?: (notice: ExtensionNotice) => void } = {}) {
    this.host = new ExtensionHost({
      sandbox: options.sandbox ?? iframeSandbox({ url: SANDBOX_URL }),
      notify: options.notify ?? showNotice,
    })
    this.ready = this.start()
  }

  private async start() {
    const installed = await listInstalledExtensions().catch((error: unknown) => {
      console.warn('[extensions] could not read the installed extensions', error)
      return []
    })
    for (const extension of installed) if (extension.enabled) this.loadQuietly(extension)
    this.stopFollowing = followKitConnections((document) => this.offer(document))
    this.update({ ready: true, installed })
  }

  /** Every open kit editor, offered to extensions while it stays open. */
  private offer(document: MountedKitDocument) {
    try {
      const port = portFromConnection(document.connection as unknown as ConnectionLike, { readOnly: () => document.readOnly ?? false })
      return this.host.openDocument({ id: document.path, kitId: document.kitId, path: document.path, port })
    } catch (error) {
      // A kit without the replica capability has no object model; extensions skip it.
      console.info('[extensions] not offering', document.path, message(error))
      return undefined
    }
  }

  private loadQuietly(extension: InstalledExtension) {
    try {
      this.host.load(packageOf(extension))
    } catch (error) {
      console.warn('[extensions] could not load', extension.id, error)
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.snapshot

  private update(next: ExtensionsSnapshot) {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  /** Installs (or updates) the extension at a workspace folder, its extension.json, or a zip; enabled. */
  async install(path: string): Promise<InstalledExtension> {
    await this.ready
    const read = await readExtensionFromWorkspace(path, readWorkspaceFile)
    const extension: InstalledExtension = { id: read.manifest.id, manifest: read.manifest, source: read.source, files: read.files, enabled: true, installedAt: Date.now(), from: read.from }
    this.host.load(packageOf(extension))
    await putInstalledExtension(extension)
    this.update({ ...this.snapshot, installed: [...this.snapshot.installed.filter((known) => known.id !== extension.id), extension] })
    return extension
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.ready
    const extension = this.snapshot.installed.find((known) => known.id === id)
    if (!extension || extension.enabled === enabled) return
    const next = { ...extension, enabled }
    if (enabled) this.host.load(packageOf(next))
    else this.host.unload(id)
    await putInstalledExtension(next)
    this.update({ ...this.snapshot, installed: this.snapshot.installed.map((known) => (known.id === id ? next : known)) })
  }

  async remove(id: string) {
    await this.ready
    this.host.unload(id)
    await deleteInstalledExtension(id)
    this.update({ ...this.snapshot, installed: this.snapshot.installed.filter((known) => known.id !== id) })
  }

  /** The kit document shown now that extensions can work on, if any. */
  activeDocument(): MountedKitDocument | null {
    return activeKitDocument()
  }

  /** Commands enabled extensions contribute to the kit document shown now. */
  paletteCommands(): PaletteExtensionCommand[] {
    const document = activeKitDocument()
    if (!document) return []
    return this.host.commandsFor(document.path).map((command) => ({ ...command, documentPath: document.path }))
  }

  /** Panels enabled extensions contribute to the kit document shown now. */
  palettePanels(): PaletteExtensionPanel[] {
    const document = activeKitDocument()
    if (!document) return []
    return this.host.panelsFor(document.path).map((panel) => ({ ...panel, documentPath: document.path }))
  }

  /** Whether the extension is installed and enabled (its panels may stay open). */
  enabled(id: string) {
    return this.snapshot.installed.some((extension) => extension.id === id && extension.enabled)
  }

  /**
   * Shows a contributed panel of the kit document at `documentPath` in `container`, sandboxed,
   * with Kition's theme. Answers its frame; failures are the caller's to show.
   */
  async showPanel(documentPath: string, target: { extension: string; panel: string }, container: HTMLElement, options: { theme: Record<string, string>; onNavigated: () => void }): Promise<PanelFrame> {
    await this.ready
    return openPanelFrame(this.host, { documentId: documentPath, ...target }, { url: PANEL_URL, container, theme: options.theme, locale: i18next.language, onNavigated: options.onNavigated })
  }

  /** Runs a contributed command; failures are shown to the person. */
  async runCommand(command: PaletteExtensionCommand): Promise<unknown> {
    try {
      return await this.host.runCommand(command.documentPath, command.extension, command.id)
    } catch (error) {
      notify.error(t('extensions.commandFailed', { title: command.title }), { description: message(error) })
      return undefined
    }
  }

  /**
   * Runs a workspace `.mjs` script (its default export takes `ctx`) against the kit document
   * shown now, with model.read, model.write, and commands.run; reports how it went.
   */
  async runScript(path: string): Promise<boolean> {
    let name = path
    try {
      const clean = cleanWorkspacePath(path)
      name = clean.split('/').pop() ?? clean
      if (!/\.m?js$/i.test(clean)) throw new Error(t('extensions.runScript.notAScript'))
      const document = activeKitDocument()
      if (!document) throw new Error(t('extensions.runScript.noDocument'))
      const source = new TextDecoder().decode(await readWorkspaceFile(clean))
      const result = await this.host.runScript({ source, name }, document.path)
      notify.success(t('extensions.runScript.done', { name }), result == null ? undefined : { description: summary(result) })
      return true
    } catch (error) {
      notify.error(t('extensions.runScript.failed', { name }), { description: message(error) })
      return false
    }
  }

  dispose() {
    this.stopFollowing?.()
    this.host.dispose()
    this.listeners.clear()
  }
}

const packageOf = (extension: InstalledExtension) => ({ manifest: extension.manifest, source: extension.source, files: extension.files ?? {} })

/** A script's answer, short enough for a notice. */
function summary(result: unknown) {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

function showNotice(notice: ExtensionNotice) {
  const show = notice.level === 'error' ? notify.error : notice.level === 'success' ? notify.success : notice.level === 'warning' ? notify.warning : notify.info
  show(notice.title, notice.description ? { description: notice.description } : undefined)
}

let service: ExtensionService | null = null

/** The window's extension service, started on first use. */
export function extensionService(): ExtensionService {
  service ??= new ExtensionService()
  return service
}

// Last: the module has run to its end (see serviceLoader.ts).
announceExtensionService(extensionService)
