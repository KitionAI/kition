// Copied from kition-sdk packages/extensions/src/sandbox.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * The sandbox for pages: a hidden `sandbox="allow-scripts"` iframe (an opaque origin: no cookies,
 * storage, or access to the host page) loaded from the host's copy of the sandbox page, whose
 * worker runs the extension. The host serves `sandbox/sandbox.html` (`SANDBOX_HTML`) at `url`;
 * it must not add a CSP header that allows more than the page's own.
 */
import { WORKER_RUNTIME } from './generated/runtime'
import type { SandboxFactory } from './host'
import { SANDBOX_TAG, type SandboxStart } from './protocol'

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
