// Copied from kition-sdk packages/extensions/src/sandbox.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The sandbox for pages: a hidden `sandbox="allow-scripts"` iframe (an opaque origin: no cookies,
 * storage, or access to the host page) loaded from the host's copy of the sandbox page, whose
 * worker runs the extension. The host serves `sandbox/sandbox.html` (`SANDBOX_HTML`) at `url`;
 * it must not add a CSP header that allows more than the page's own.
 */
import { WORKER_RUNTIME } from './generated/runtime'
import type { ExtensionHost, PanelSession, SandboxFactory } from './host'
import { PANEL_TAG, SANDBOX_TAG, type PanelStart, type SandboxStart } from './protocol'

export type IframeSandboxOptions = {
  /** Where the host serves the sandbox page. */
  url: string
  /** Where the hidden frames go (`document.body` by default). */
  container?: HTMLElement
  /** How long the page may take to load (ms). */
  loadTimeoutMs?: number
}

export function iframeSandbox(options: IframeSandboxOptions): SandboxFactory {
  return async ({ id, connect }) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.title = `Extension ${id}`
    frame.dataset.kitionExtension = id
    frame.style.display = 'none'
    frame.referrerPolicy = 'no-referrer'
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the sandbox page for ${id} did not load from ${options.url}`)), options.loadTimeoutMs ?? 15_000)
      frame.addEventListener(
        'load',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    frame.src = options.url
    ;(options.container ?? document.body).appendChild(frame)
    try {
      await loaded
    } catch (error) {
      frame.remove()
      throw error
    }
    const channel = new MessageChannel()
    const start: SandboxStart = { tag: SANDBOX_TAG, type: 'start', runtime: WORKER_RUNTIME, connect }
    // The frame's origin is opaque, so no target origin names it; the page checks it is ours.
    frame.contentWindow!.postMessage(start, '*', [channel.port2])
    return {
      port: channel.port1,
      dispose: () => {
        channel.port1.close()
        frame.remove()
      },
    }
  }
}

export type PanelFrameOptions = {
  /** Where the host serves the panel page (`sandbox/panel.html`, `PANEL_HTML`). */
  url: string
  /** Where the panel's frame goes; it fills it. */
  container: HTMLElement
  /** CSS custom properties for the panel (the host's theme), as `--name: value`. */
  theme?: Record<string, string>
  /** The host's language, for the panel's `lang`. */
  locale?: string
  /** How long the page may take to load (ms). */
  loadTimeoutMs?: number
  /** The frame loaded another page (the panel navigated): it has been removed. */
  onNavigated?: () => void
}

/** A panel shown in a frame. */
export type PanelFrame = { frame: HTMLIFrameElement; dispose: () => void }

/**
 * Shows a contributed panel of an extension for a document in a visible `sandbox="allow-scripts"`
 * frame (an opaque origin, like the extension's worker) loaded from the host's copy of the panel
 * page, with the extension's own `connect-src`. The panel and the extension's worker talk over a
 * `MessageChannel` of their own. A frame that loads another page is removed: a panel never leaves
 * its page (the host's `frame-src` keeps it from loading another origin's).
 */
export async function openPanelFrame(
  host: Pick<ExtensionHost, 'panelContent' | 'openPanel'>,
  target: { documentId: string; extension: string; panel: string },
  options: PanelFrameOptions,
): Promise<PanelFrame> {
  const content = host.panelContent(target.extension, target.panel)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = content.title
  frame.dataset.kitionPanel = `${target.extension}:${target.panel}`
  frame.referrerPolicy = 'no-referrer'
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the panel page for ${target.extension} did not load from ${options.url}`)), options.loadTimeoutMs ?? 15_000)
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
  frame.src = options.url
  options.container.appendChild(frame)
  let session: PanelSession | null = null
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    session?.close()
    frame.remove()
  }
  try {
    await loaded
    const channel = new MessageChannel()
    session = await host.openPanel(target.documentId, target.extension, target.panel, channel.port2)
    if (disposed) {
      session.close()
      throw new Error('the panel was closed while it opened')
    }
    const start: PanelStart = {
      tag: PANEL_TAG,
      type: 'start',
      html: content.html,
      connect: content.connect,
      ...(options.theme ? { theme: options.theme } : {}),
      info: { extension: target.extension, panel: target.panel, documentId: target.documentId, title: content.title, ...(options.locale ? { locale: options.locale } : {}) },
    }
    // The frame's origin is opaque, so no target origin names it; the page checks it is ours.
    frame.contentWindow!.postMessage(start, '*', [channel.port1])
    frame.addEventListener('load', () => {
      dispose()
      options.onNavigated?.()
    })
  } catch (error) {
    dispose()
    throw error
  }
  return { frame, dispose }
}
