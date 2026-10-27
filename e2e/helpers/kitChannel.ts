import type { FrameLocator, Page } from '@playwright/test'

/** A kit's answer to one request: its result, or a JSON-RPC error with the KitFiles reason. */
export type KitAnswer = { result?: Record<string, any>; error?: { code: number; message: string; data?: { reason?: string } } }

/** Every frame keeps the host channel it is handed (`ui/initialize`), so a spec can speak for the kit. */
export async function keepKitChannels(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if ((event.data as { kitionKitUi?: number } | null)?.kitionKitUi === 1 && event.ports[0]) (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort = event.ports[0]
    })
  })
}

/**
 * Sends one request from inside the note kit's frame over its host channel, as its editor does;
 * `bytes` (text) goes as the request's ArrayBuffer `bytes`. Bytes the host answers come back as
 * `text`: an ArrayBuffer does not leave the frame.
 */
export async function requestFromNote(page: Page, method: string, params: Record<string, unknown>, bytes?: string): Promise<KitAnswer> {
  const frame = page.frames().find((candidate) => candidate.url().includes('/kits/note-ui/'))
  if (!frame) throw new Error('the note kit frame is not open')
  return frame.evaluate(
    async ({ method, params, bytes }) => {
      const port = (window as unknown as { __e2eKitPort?: MessagePort }).__e2eKitPort
      if (!port) throw new Error('the kit has no host channel')
      const id = `e2e-${Math.random().toString(36).slice(2)}`
      return new Promise<KitAnswer>((resolve) => {
        const answer = (event: MessageEvent) => {
          if (event.data?.id !== id) return
          port.removeEventListener('message', answer)
          const bytes = event.data.result?.bytes
          resolve(bytes ? { ...event.data, result: { ...event.data.result, bytes: undefined, text: new TextDecoder().decode(bytes) } } : event.data)
        }
        port.addEventListener('message', answer)
        const body = bytes === undefined ? params : { ...params, bytes: new TextEncoder().encode(bytes).buffer }
        port.postMessage({ jsonrpc: '2.0', id, method, params: body })
      })
    },
    { method, params, bytes },
  )
}

/** A person's gesture in the note kit, which `files/create`, `files/pick`, and `files/print` need (FA6, FA11). */
export const noteGesture = (kit: FrameLocator) => kit.getByTestId('note-title').click()
